const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "stem-jobs");
const TMP_DIR = path.join(DATA_DIR, "uploads");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 250);
const MODEL = process.env.STEM_MODEL || "htdemucs_6s";
const BUCKET = process.env.STEM_BUCKET || "stem-audio-private";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: true
});
const activeJobs = new Set();
fs.mkdirSync(TMP_DIR, { recursive: true });

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"].includes(ext)) {
      return cb(new Error("Unsupported audio format. Use MP3, WAV, FLAC, M4A, AAC, OGG or OPUS."));
    }
    cb(null, true);
  }
});

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const safeName = name => path.basename(name).replace(/[^a-z0-9._-]/gi, "_").slice(0, 180) || "audio";

async function updateJob(id, fields) {
  const allowed = ["status", "progress", "message", "result_key", "source_duration_seconds", "result_manifest", "error", "attempt_count", "completed_at"];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const values = [id];
  const sets = entries.map(([key, value], index) => {
    values.push(value);
    return key + " = $" + (index + 2);
  });
  sets.push("updated_at = NOW()");
  await pool.query("UPDATE public.stem_jobs SET " + sets.join(", ") + " WHERE id = $1", values);
}

async function downloadObject(key, destination) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) throw new Error("Object storage returned an empty file.");
  await pipeline(result.Body, fs.createWriteStream(destination));
}

async function uploadObject(key, filePath, contentType) {
  const stat = await fs.promises.stat(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: stat.size,
    ContentType: contentType
  }));
}

function runDemucs(inputPath, jobDir, id) {
  return new Promise((resolve, reject) => {
    const worker = spawn("python3", [path.join(__dirname, "worker.py"), inputPath, jobDir, id], {
      env: { ...process.env, STEM_MODEL: MODEL },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let progress = 8;
    let lastMessage = "Starting audio separation…";
    let writeChain = Promise.resolve();
    const record = line => {
      const message = String(line || "").trim().slice(-400);
      if (!message) return;
      lastMessage = message;
      progress = Math.min(92, progress + 2);
      writeChain = writeChain.then(() => updateJob(id, { progress, message })).catch(err => console.error("Could not update job progress:", err.message));
    };
    worker.stdout.on("data", data => data.toString().split(/\r?\n/).forEach(record));
    worker.stderr.on("data", data => data.toString().split(/\r?\n/).forEach(record));
    worker.on("error", reject);
    worker.on("close", async code => {
      await writeChain;
      if (code === 0) resolve(lastMessage);
      else reject(new Error(lastMessage || "Demucs exited with code " + code));
    });
  });
}

async function processJob(id) {
  if (activeJobs.has(id)) return;
  activeJobs.add(id);
  let jobDir;
  try {
    const result = await pool.query("SELECT * FROM public.stem_jobs WHERE id = $1", [id]);
    const job = result.rows[0];
    if (!job || !["queued", "processing"].includes(job.status)) return;
    jobDir = path.join(DATA_DIR, id);
    await fs.promises.mkdir(jobDir, { recursive: true });
    const ext = path.extname(job.original_name).toLowerCase() || ".audio";
    const inputPath = path.join(jobDir, "original" + ext);
    if (!fs.existsSync(inputPath)) await downloadObject(job.input_key, inputPath);
    await updateJob(id, {
      status: "processing",
      progress: 8,
      message: "Audio is ready. Demucs is separating the sources…",
      error: null,
      attempt_count: Number(job.attempt_count || 0) + 1
    });
    await runDemucs(inputPath, jobDir, id);
    const zipPath = path.join(jobDir, "stem-results.zip");
    if (!fs.existsSync(zipPath)) throw new Error("The worker finished without creating the result archive.");
    const resultKey = "results/" + id + "/stem-results.zip";
    await uploadObject(resultKey, zipPath, "application/zip");
    const manifestPath = path.join(jobDir, "deliverables", "manifest.json");
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) : null;
    await updateJob(id, {
      status: "completed",
      progress: 100,
      message: "Your stem pack is safely stored and ready to download.",
      result_key: resultKey,
      result_manifest: manifest,
      completed_at: new Date()
    });
  } catch (error) {
    console.error("STEM job failed:", id, error);
    await updateJob(id, { status: "failed", progress: 100, message: error.message, error: error.stack || error.message }).catch(dbError => console.error("Could not persist failure:", dbError.message));
  } finally {
    if (jobDir) await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    activeJobs.delete(id);
  }
}

app.get("/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({
    ok: true,
    service: "STEM Audio Workbench",
    version: "2.0.0",
    database: "connected",
    objectStorage: Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    bucket: BUCKET
  });
}));

app.get("/api/capabilities", (_req, res) => res.json({
  engine: "Demucs",
  model: MODEL,
  sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
  formats: ["wav", "mp3"],
  maxUploadMB: MAX_UPLOAD_MB,
  persistentJobs: true,
  objectStorage: "Neon Object Storage",
  note: "Source separation is an estimate. Complex mixes may contain bleed between stems."
}));

app.post("/api/jobs", upload.single("audio"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an audio file first." });
  const id = randomUUID();
  const originalName = safeName(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase() || ".audio";
  const inputKey = "uploads/" + id + "/original" + ext;
  try {
    await uploadObject(inputKey, req.file.path, "application/octet-stream");
    await pool.query(
      "INSERT INTO public.stem_jobs (id, original_name, status, progress, message, input_key, model) VALUES ($1,$2,'queued',3,'Upload stored. Waiting for the audio worker…',$3,$4)",
      [id, originalName, inputKey, MODEL]
    );
  } catch (error) {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: inputKey })).catch(() => {});
    throw error;
  } finally {
    await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
  }
  res.status(202).json({ id, status: "queued", statusUrl: "/api/jobs/" + id });
  void processJob(id);
}));

app.get("/api/jobs/:id", asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id, original_name AS name, status, progress, message, created_at AS \"createdAt\", result_key FROM public.stem_jobs WHERE id = $1",
    [req.params.id]
  );
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({
    id: job.id,
    name: job.name,
    status: job.status,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    downloadUrl: job.status === "completed" ? "/api/jobs/" + job.id + "/download" : null
  });
}));

app.get("/api/jobs/:id/download", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT original_name, status, result_key FROM public.stem_jobs WHERE id = $1", [req.params.id]);
  const job = result.rows[0];
  if (!job || job.status !== "completed" || !job.result_key) return res.status(404).json({ error: "Result is not ready." });
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: job.result_key }));
  if (!object.Body) return res.status(404).json({ error: "Stored result could not be read." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=\"STEM-" + safeName(job.original_name) + "-stems.zip\"");
  if (object.ContentLength) res.setHeader("Content-Length", String(object.ContentLength));
  object.Body.pipe(res);
}));

app.use((err, _req, res, _next) => {
  console.error("STEM API error:", err);
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({ error: err.message || "Request failed." });
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Configure the Neon connection string in the server environment.");
  if (!process.env.AWS_ENDPOINT_URL_S3 || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Neon Object Storage credentials are missing. Configure AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION.");
  }
  await pool.query("SELECT 1");
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
    completed_at TIMESTAMPTZ
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS stem_jobs_status_created_idx ON public.stem_jobs (status, created_at)");
  await pool.query("UPDATE public.stem_jobs SET status='queued', message='Worker restarted; job returned to queue.', updated_at=NOW() WHERE status='processing'");
  app.listen(PORT, "0.0.0.0", async () => {
    console.log("STEM server listening on " + PORT);
    const queued = await pool.query("SELECT id FROM public.stem_jobs WHERE status='queued' ORDER BY created_at ASC");
    for (const row of queued.rows) await processJob(row.id);
  });
}

start().catch(error => {
  console.error("Could not start STEM server:", error);
  process.exit(1);
});
