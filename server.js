const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Pool } = require('pg');
const unzipper = require('unzipper');
const { Upload } = require('@aws-sdk/lib-storage');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
// Render terminates TLS and forwards requests through one trusted proxy hop.
// This lets express-rate-limit identify the original client safely.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'stem-jobs');
const TMP_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 250);
const MODEL = process.env.STEM_MODEL || 'htdemucs_6s';
const BUCKET = process.env.STEM_BUCKET || 'stem-audio-private';
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
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);
const MAX_ZIP_TRACKS = Number(process.env.MAX_ZIP_TRACKS || 20);
const MAX_ZIP_UNPACKED_MB = Number(process.env.MAX_ZIP_UNPACKED_MB || 1024);
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Please wait before starting another separation.' }
});

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
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext) && ext !== '.zip') {
      return callback(new Error('Upload one audio file or a ZIP containing audio tracks.'));
    }
    callback(null, true);
  }
});

const resultUpload = multer({ dest: TMP_DIR, limits: { fileSize: Number(process.env.MAX_RESULT_MB || 2048) * 1024 * 1024 } });
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
  downloadUrl: job.status === 'completed' ? '/api/jobs/' + job.id + '/download' : null,
  processor: job.processor || 'legacy'
});

async function updateJob(id, fields) {
  const allowed = [
    'status', 'progress', 'message', 'result_key', 'result_manifest',
    'error', 'attempt_count', 'completed_at'
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

async function uploadFile(key, filePath, contentType) {
  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || 'application/octet-stream'
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false
  });
  await uploader.done();
}

async function getObjectStream(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) throw new Error('The private storage object is empty.');
  return result;
}







// Processing now runs through the open-source local Demucs worker or an optional free cloud worker. The API stores job state and results only.









app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  const storageProbeKey = 'health-checks/' + randomUUID() + '.txt';
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: storageProbeKey, Body: 'STEM storage connection check', ContentType: 'text/plain' }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageProbeKey }));
  res.json({ ok: Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY), service: 'STEM Audio Workbench', version: '4.0.0', database: 'connected', objectStorage: true, processing: 'local-demucs-with-optional-free-cloud-worker', bucket: BUCKET });
}));

app.get('/api/capabilities', (_req, res) => res.json({
  engine: 'Open-source Demucs', model: MODEL, providers: ['local-device', 'optional-free-cloud-worker'],
  sources: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'], formats: ['wav', 'mp3'],
  maxUploadMB: MAX_UPLOAD_MB, zipUploads: true, maxZipTracks: MAX_ZIP_TRACKS,
  maxZipUnpackedMB: MAX_ZIP_UNPACKED_MB, persistentJobs: true, objectStorage: 'Neon Object Storage',
  note: 'Local processing has no per-track API fee. Optional free cloud capacity is quota-limited and may be unavailable.'
}));

app.post('/api/jobs/local', asyncRoute(async (req, res) => {
  const id = randomUUID();
  const originalName = safeName(String(req.body?.name || 'audio.wav'));
  const outputFormat = req.body?.outputFormat === 'mp3' ? 'mp3' : 'wav';
  const sourceType = req.body?.sourceType === 'zip' ? 'zip' : 'audio';
  const sizeBytes = Math.max(0, Number(req.body?.sizeBytes || 0));
  if (!sizeBytes || sizeBytes > MAX_UPLOAD_MB * 1024 * 1024) return res.status(400).json({ error: 'The selected file is empty or exceeds the upload limit.' });
  await pool.query(
    "INSERT INTO public.stem_jobs (id, original_name, status, progress, message, input_key, model, output_format, input_size_bytes, input_content_type, source_type, processor) VALUES ($1,$2,'queued',3,'Job saved. Waiting for a free Demucs processor…','',$3,$4,$5,$6,$7,'local-demucs')",
    [id, originalName, MODEL, outputFormat, sizeBytes, String(req.body?.contentType || 'application/octet-stream'), sourceType]
  );
  res.status(202).json({ id, status: 'queued', statusUrl: '/api/jobs/' + id, processor: 'local-demucs' });
}));

// Backwards-compatible upload endpoint. It stores jobs but never invokes a paid processor.
app.post('/api/jobs', uploadLimiter, upload.single('audio'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file or ZIP package first.' });
  const id = randomUUID(), originalName = safeName(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase() || '.audio';
  const inputKey = 'uploads/' + id + '/original' + ext;
  const outputFormat = req.body.outputFormat === 'mp3' ? 'mp3' : 'wav';
  try {
    await uploadFile(inputKey, req.file.path, req.file.mimetype || 'application/octet-stream');
    await pool.query(
      "INSERT INTO public.stem_jobs (id, original_name, status, progress, message, input_key, model, output_format, input_size_bytes, input_content_type, source_type, processor) VALUES ($1,$2,'queued',3,'Upload saved. Waiting for a free Demucs processor…',$3,$4,$5,$6,$7,$8,'local-demucs')",
      [id, originalName, inputKey, MODEL, outputFormat, req.file.size, req.file.mimetype || 'application/octet-stream', ext === '.zip' ? 'zip' : 'audio']
    );
  } finally { await fs.promises.rm(req.file.path, { force: true }).catch(() => {}); }
  res.status(202).json({ id, status: 'queued', statusUrl: '/api/jobs/' + id });
}));

app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(publicJob(job));
}));

app.post('/api/jobs/:id/local-result', resultUpload.single('archive'), asyncRoute(async (req, res) => {
  const jobResult = await pool.query('SELECT * FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = jobResult.rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!req.file) return res.status(400).json({ error: 'The processor did not return a result archive.' });
  if (job.status === 'completed') return res.status(409).json({ error: 'This job already has completed results.' });
  const workDir = path.join(DATA_DIR, 'result-' + job.id + '-' + randomUUID());
  await fs.promises.mkdir(workDir, { recursive: true });
  try {
    const directory = await unzipper.Open.file(req.file.path);
    const entries = directory.files.filter(entry => entry.type === 'File' && AUDIO_EXTENSIONS.has(path.extname(entry.path).toLowerCase()));
    if (!entries.length || entries.length > 120) throw new Error('The result archive has no valid stems or contains too many files.');
    const archiveKey = 'results/' + job.id + '/stem-results.zip';
    await uploadFile(archiveKey, req.file.path, 'application/zip');
    const manifestFiles = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const safeParts = entry.path.split('/').filter(part => part && part !== '.' && part !== '..').map(safeName);
      const relativeName = safeParts.join('/');
      const localPath = path.join(workDir, String(index).padStart(3, '0') + '-' + safeName(path.basename(relativeName)));
      await pipeline(entry.stream(), fs.createWriteStream(localPath));
      const objectKey = 'results/' + job.id + '/' + relativeName;
      const contentType = path.extname(relativeName).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav';
      await uploadFile(objectKey, localPath, contentType);
      const stat = await fs.promises.stat(localPath);
      manifestFiles.push({ track: safeParts.length > 1 ? safeParts.slice(0, -1).join('/') : null, stem: path.parse(relativeName).name, fileName: relativeName, objectKey, sizeBytes: stat.size, contentType });
    }
    const files = await Promise.all(manifestFiles.map(async file => ({
      ...file, downloadUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: file.objectKey }), { expiresIn: 60 * 60 })
    })));
    await updateJob(job.id, {
      status: 'completed', progress: 100, message: 'Your stems are ready. Processed with open-source Demucs.',
      result_key: archiveKey, result_manifest: { model: MODEL, processor: 'local-demucs', outputFormat: job.output_format || 'wav', files }, completed_at: new Date()
    });
    res.json({ id: job.id, status: 'completed', results: files.length });
  } finally {
    await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}));

app.get('/api/jobs/:id/results', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT status, result_manifest FROM public.stem_jobs WHERE id = $1', [req.params.id]);
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'completed' || !job.result_manifest) return res.status(409).json({ error: 'Results are not ready.' });
  const files = await Promise.all((job.result_manifest.files || []).map(async file => ({
    ...file,
    downloadUrl: await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET,
      Key: file.objectKey
    }), { expiresIn: 60 * 60 })
  })));
  res.json({ ...job.result_manifest, files });
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
  const status = err instanceof multer.MulterError ? 413 : (err.status || 400);
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
    processor TEXT NOT NULL DEFAULT 'legacy',
    output_format TEXT NOT NULL DEFAULT 'wav',
    input_size_bytes BIGINT,
    input_content_type TEXT,
    source_type TEXT NOT NULL DEFAULT 'audio'
  )`);
  await pool.query('ALTER TABLE public.stem_jobs ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES public.stem_jobs(id) ON DELETE CASCADE');
  await pool.query('CREATE INDEX IF NOT EXISTS stem_jobs_parent_job_idx ON public.stem_jobs (parent_job_id) WHERE parent_job_id IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS stem_jobs_status_created_idx ON public.stem_jobs (status, created_at)');
  app.listen(PORT, '0.0.0.0', () => { console.log('STEM free Demucs API listening on ' + PORT); });

}

start().catch(error => {
  console.error('Could not start STEM server:', error.message);
  process.exit(1);
});
