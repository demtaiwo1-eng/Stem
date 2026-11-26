const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "stem-jobs");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 250);
const jobs = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({
  dest: DATA_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"].includes(ext)) {
      return cb(new Error("Unsupported audio format. Use MP3, WAV, FLAC, M4A, AAC, OGG or OPUS."));
    }
    cb(null, true);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "STEM Audio Workbench", version: "1.0.0" }));
app.get("/api/capabilities", (_req, res) => res.json({
  engine: "Demucs",
  model: "htdemucs_6s",
  sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
  formats: ["wav", "mp3"],
  maxUploadMB: MAX_UPLOAD_MB,
  note: "Source separation is an estimate. Complex mixes may contain bleed between stems."
}));

app.post("/api/jobs", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an audio file first." });
  const id = randomUUID();
  const jobDir = path.join(DATA_DIR, id);
  fs.mkdirSync(jobDir, { recursive: true });
  const ext = path.extname(req.file.originalname).toLowerCase() || ".audio";
  const inputPath = path.join(jobDir, "original" + ext);
  fs.renameSync(req.file.path, inputPath);
  const job = { id, name: req.file.originalname, status: "queued", progress: 2, message: "Preparing audio…", createdAt: new Date().toISOString(), jobDir };
  jobs.set(id, job);
  const worker = spawn("python3", [path.join(__dirname, "worker.py"), inputPath, jobDir, id], {
    env: { ...process.env, STEM_MODEL: process.env.STEM_MODEL || "htdemucs_6s" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  job.status = "processing";
  worker.stdout.on("data", d => {
    const line = d.toString().trim();
    if (line) { job.message = line.slice(-400); job.progress = Math.min(92, job.progress + 2); }
  });
  worker.stderr.on("data", d => {
    const line = d.toString().trim();
    if (line) job.message = line.slice(-400);
  });
  worker.on("error", err => { job.status = "failed"; job.message = err.message; });
  worker.on("close", code => {
    if (code === 0 && fs.existsSync(path.join(jobDir, "stem-results.zip"))) {
      job.status = "completed"; job.progress = 100; job.message = "Your stem pack is ready.";
      job.downloadUrl = "/api/jobs/" + id + "/download";
    } else {
      job.status = "failed"; job.message = job.message || "Audio processing failed. Check the server logs and available memory.";
    }
  });
  res.status(202).json({ id, status: job.status, statusUrl: "/api/jobs/" + id });
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found. Jobs are stored in server memory and may reset after a restart." });
  res.json({ id: j.id, name: j.name, status: j.status, progress: j.progress, message: j.message, createdAt: j.createdAt, downloadUrl: j.downloadUrl || null });
});
app.get("/api/jobs/:id/download", (req, res) => {
  const j = jobs.get(req.params.id);
  const zip = j && path.join(j.jobDir, "stem-results.zip");
  if (!j || j.status !== "completed" || !fs.existsSync(zip)) return res.status(404).json({ error: "Result is not ready or has expired." });
  res.download(zip, "STEM-" + j.name.replace(/[^a-z0-9._-]/gi, "_") + "-stems.zip");
});
app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({ error: err.message || "Request failed." });
});
app.listen(PORT, "0.0.0.0", () => console.log("STEM server listening on " + PORT));
