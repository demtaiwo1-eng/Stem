const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Pool } = require('pg');
const archiver = require('archiver');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'stem-jobs');
const TMP_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 250);
const MODEL = process.env.STEM_MODEL || 'htdemucs_6s';
const FAL_MODEL = process.env.FAL_MODEL || 'fal-ai/demucs';
const BUCKET = process.env.STEM_BUCKET || 'stem-audio-private';
const FAL_API_KEY = process.env.FAL_API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://demtaiwo1-eng.github.io')
  .split(',').map(value => value.trim()).filter(Boolean);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: process.env.AWS_FORCE_PATH_STYLE !== 'false',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});
const activeJobs = new Set();

fs.mkdirSync(TMP_DIR, { recursive: true });
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('This website is not allowed to access the STEM API.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'].includes(ext)) {
      return callback(new Error('Upload one audio file: MP3, WAV, FLAC, M4A, AAC, OGG or OPUS.'));
    }
    callback(null, true);
  }
});

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const safeName = name => path.basename(name).replace(/[^a-z0-9._-]/gi, '_').slice(0, 150) || 'audio';
const publicJob = job => ({
  id: job.id,
  name: job.original_name,
  status: job.status,
  progress: job.progress,
  message: job.message,
  createdAt: job.created_at,
  outputFormat: job.output_format,
  results: job.status === 'completed' ? job.result_manifest?.files || [] : [],
  downloadUrl: job.status === 'completed' ? '/api/jobs/' + job.id + '/download' : null
});

async function updateJob(id, fields) {
  const allowed = [
    'status', 'progress', 'message', 'result_key', 'result_manifest',
    'error', 'attempt_count', 'completed_at', 'fal_request_id',
    'fal_status_url', 'fal_response_url'
  ];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const values = [id];
  const sets = entries.map(([key, value], index) => {
    values.push(value);
    return key + ' = $' + (index + 2);
  });
  sets.push('updated_at = NOW()');
  await pool.query('UPDATE public.stem_jobs SET ' + sets.join(', ') + ' WHERE id = $1', values);
}

async function uploadBuffer(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream'
  }));
}

async function getObjectStream(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) throw new Error('The private storage object is empty.');
  return result;
}

async function signedInputUrl(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 60 * 60 * 3 });
}

async function submitFalJob(job) {
  if (!FAL_API_KEY) throw new Error('FAL_API_KEY is not configured on the server.');
  const audioUrl = await signedInputUrl(job.input_key);
  const response = await fetch('https://queue.fal.run/' + FAL_MODEL, {
    method: 'POST',
    headers: {
      Authorization: 'Key ' + FAL_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      model: MODEL,
      stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
      output_format: job.output_format || 'wav'
    }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'FAL rejected the separation request (' + response.status + ').');
  }
  if (!payload.request_id || !payload.status_url || !payload.response_url) {
    throw new Error('FAL returned an incomplete queue response.');
  }
  await updateJob(job.id, {
    status: 'processing',
    progress: 12,
    message: 'FAL Demucs accepted your audio. Waiting for six separated stems…',
    fal_request_id: payload.request_id,
    fal_status_url: payload.status_url,
    fal_response_url: payload.response_url,
    attempt_count: Number(job.attempt_count || 0) + 1
  });
}

async function downloadRemoteFile(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Could not retrieve a finished audio stem (' + response.status + ').');
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'audio/mpeg'
  };
}

async function buildArchive(jobId, files, jobDir) {
  const archivePath = path.join(jobDir, 'stem-results.zip');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) archive.file(file.localPath, { name: file.fileName });
    archive.finalize();
  });
  const zipBuffer = await fs.promises.readFile(archivePath);
  const resultKey = 'results/' + jobId + '/stem-results.zip';
  await uploadBuffer(resultKey, zipBuffer, 'application/zip');
  return resultKey;
}

async function finishFalJob(job) {
  const response = await fetch(job.fal_response_url, { signal: AbortSignal.timeout(60000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || 'FAL result retrieval failed (' + response.status + ').');
  const stems = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
  const jobDir = path.join(DATA_DIR, job.id);
  await fs.promises.mkdir(jobDir, { recursive: true });
  const files = [];
  try {
    for (const stem of stems) {
      const item = payload[stem];
      if (!item?.url) continue;
      const remote = await downloadRemoteFile(item.url);
      const ext = (job.output_format || 'wav') === 'wav' ? 'wav' : 'mp3';
      const fileName = stem + '.' + ext;
      const objectKey = 'results/' + job.id + '/' + fileName;
      await uploadBuffer(objectKey, remote.buffer, remote.contentType);
      const localPath = path.join(jobDir, fileName);
      await fs.promises.writeFile(localPath, remote.buffer);
      files.push({
        stem,
        fileName,
        objectKey,
        sizeBytes: remote.buffer.length,
        contentType: remote.contentType,
        localPath
      });
    }
    if (files.length < 4) throw new Error('FAL returned fewer than four expected stems; the result was not published.');
    const resultKey = await buildArchive(job.id, files, jobDir);
    const manifestFiles = await Promise.all(files.map(async file => ({
      stem: file.stem,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      downloadUrl: await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET,
        Key: file.objectKey
      }), { expiresIn: 60 * 60 })
    })));
    await updateJob(job.id, {
      status: 'completed',
      progress: 100,
      message: 'Your separated stems are ready to preview and download.',
      result_key: resultKey,
      result_manifest: { model: MODEL, outputFormat: job.output_format || 'wav', files: manifestFiles },
      completed_at: new Date()
    });
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processFalJob(id) {
  if (activeJobs.has(id)) return;
  activeJobs.add(id);
  try {
    const result = await pool.query('SELECT * FROM public.stem_jobs WHERE id = $1', [id]);
    const job = result.rows[0];
    if (!job || ['completed', 'failed'].includes(job.status)) return;
    if (!job.fal_request_id) {
      await updateJob(id, { status: 'queued', progress: 8, message: 'Preparing a secure audio hand-off to FAL…' });
      await submitFalJob(job);
      return;
    }
    const statusResponse = await fetch(job.fal_status_url, {
      headers: { Authorization: 'Key ' + FAL_API_KEY },
      signal: AbortSignal.timeout(20000)
    });
    const status = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) throw new Error(status.detail || 'FAL status check failed (' + statusResponse.status + ').');
    if (status.status === 'COMPLETED') {
      await updateJob(id, { progress: 88, message: 'Separation complete. Saving your stems to private storage…' });
      await finishFalJob(job);
    } else if (status.status === 'FAILED') {
      throw new Error(status.error || 'FAL could not separate this audio.');
    } else {
      const progress = status.status === 'IN_PROGRESS' ? 55 : 24;
      await updateJob(id, {
        status: 'processing',
        progress,
        message: status.status === 'IN_PROGRESS' ? 'Demucs is separating the six audio layers…' : 'Your audio is in the FAL processing queue…'
      });
    }
  } catch (error) {
    console.error('STEM FAL job failed:', id, error.message);
    await updateJob(id, {
      status: 'failed',
      progress: 100,
      message: error.message || 'Audio processing failed.',
      error: error.stack || error.message
    }).catch(dbError => console.error('Could not persist FAL failure:', dbError.message));
  } finally {
    activeJobs.delete(id);
  }
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({
    ok: true,
    service: 'STEM Audio Workbench',
    version: '3.0.0',
    database: 'connected',
    objectStorage: Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    falConfigured: Boolean(FAL_API_KEY),
    bucket: BUCKET
  });
}));

app.get('/api/capabilities', (_req, res) => res.json({
  engine: 'FAL Demucs',
  model: MODEL,
  sources: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  formats: ['wav', 'mp3'],
  maxUploadMB: MAX_UPLOAD_MB,
  persistentJobs: true,
  objectStorage: 'Neon Object Storage',
  note: 'Source separation is an estimate. Complex mixes may contain bleed between stems.'
}));

app.post('/api/jobs', upload.single('audio'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file first.' });
  const id = randomUUID();
  const originalName = safeName(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase() || '.audio';
  const inputKey = 'uploads/' + id + '/original' + ext;
  const outputFormat = req.body.outputFormat === 'mp3' ? 'mp3' : 'wav';
  try {
    const body = await fs.promises.readFile(req.file.path);
    await uploadBuffer(inputKey, body, req.file.mimetype || 'application/octet-stream');
    await pool.query(
      'INSERT INTO public.stem_jobs (id, original_name, status, progress, message, input_key, model, output_format, input_size_bytes, input_content_type, source_type) VALUES ($1,$2,\'queued\',5,\'Upload stored securely. Preparing FAL Demucs…\',$3,$4,$5,$6,$7,\'audio\')',
      [id, originalName, inputKey, MODEL, outputFormat, req.file.size, req.file.mimetype || 'application/octet-stream']
    );
  } finally {
    await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
  }
  res.status(202).json({ id, status: 'queued', statusUrl: '/api/jobs/' + id });
  void processFalJob(id);
}));

app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.fal_request_id && ['queued', 'processing'].includes(job.status)) void processFalJob(job.id);
  const fresh = await pool.query('SELECT * FROM public.stem_jobs WHERE id = $1', [job.id]);
  res.json(publicJob(fresh.rows[0]));
}));

app.get('/api/jobs/:id/results', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT status, result_manifest FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'completed' || !job.result_manifest) return res.status(409).json({ error: 'Results are not ready.' });
  res.json(job.result_manifest);
}));

app.get('/api/jobs/:id/download', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT original_name, status, result_key FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = result.rows[0];
  if (!job || job.status !== 'completed' || !job.result_key) return res.status(404).json({ error: 'Result is not ready.' });
  const object = await getObjectStream(job.result_key);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="STEM-' + safeName(job.original_name) + '-stems.zip"');
  if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));
  await pipeline(object.Body, res);
}));

app.use((err, _req, res, _next) => {
  console.error('STEM API error:', err.message);
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({ error: err.message || 'Request failed.' });
});

async function start() {
  const missing = ['DATABASE_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
    .filter(key => !process.env[key]);
  if (missing.length) {
    console.warn('STEM API is not ready for processing. Missing server settings:', missing.join(', '));
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  await pool.query('SELECT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS public.stem_jobs (
    id UUID PRIMARY KEY,
    original_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
    progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    message TEXT NOT NULL DEFAULT '',
    input_key TEXT NOT NULL,
    result_key TEXT,
    source_duration_seconds DOUBLE PRECISION,
    model TEXT NOT NULL DEFAULT 'htdemucs_6s',
    result_manifest JSONB,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    fal_request_id TEXT,
    fal_status_url TEXT,
    fal_response_url TEXT,
    output_format TEXT NOT NULL DEFAULT 'wav',
    input_size_bytes BIGINT,
    input_content_type TEXT,
    source_type TEXT NOT NULL DEFAULT 'audio'
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS stem_jobs_status_created_idx ON public.stem_jobs (status, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS stem_jobs_fal_request_idx ON public.stem_jobs (fal_request_id) WHERE fal_request_id IS NOT NULL');
  app.listen(PORT, '0.0.0.0', () => {
    console.log('STEM FAL API listening on ' + PORT);
    setInterval(async () => {
      const queued = await pool.query(
        "SELECT id FROM public.stem_jobs WHERE status IN ('queued','processing') ORDER BY created_at ASC LIMIT 20"
      ).catch(error => {
        console.error('Could not recover queued STEM jobs:', error.message);
        return { rows: [] };
      });
      for (const row of queued.rows) void processFalJob(row.id);
    }, 5000).unref();
  });
}

start().catch(error => {
  console.error('Could not start STEM server:', error.message);
  process.exit(1);
});
