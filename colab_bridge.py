import json, os, re, shutil, subprocess, sys, threading, time, uuid
from pathlib import Path
from flask import Flask, jsonify, request, send_file, abort
from flask_cors import CORS
from werkzeug.utils import secure_filename

ROOT = Path(os.environ.get("STEM_BRIDGE_DATA", "/content/stem-bridge-data"))
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("STEM_BRIDGE_TOKEN", "")
WORKER = Path(__file__).with_name("worker.py")
DEVICE = os.environ.get("STEM_DEVICE", "cpu")
MODEL = os.environ.get("STEM_MODEL", "htdemucs_6s")
jobs = {}
lock = threading.Lock()
allowed = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 250 * 1024 * 1024
CORS(app, resources={r"/*": {"origins": "*", "allow_headers": ["Content-Type", "X-STEM-Token"], "methods": ["GET", "POST", "OPTIONS"]}})

def authorized():
    return bool(TOKEN) and request.headers.get("X-STEM-Token", "") == TOKEN

def require_auth():
    if not authorized():
        return jsonify({"error": "Invalid or missing STEM session token. Copy the current token from the Colab notebook."}), 401
    return None

def update_job(job_id, **fields):
    with lock:
        if job_id in jobs:
            jobs[job_id].update(fields)

def process_job(job_id, source_path, job_dir):
    update_job(job_id, status="processing", progress=5, message="Starting audio separation in your Colab session…")
    env = os.environ.copy()
    env["STEM_DEVICE"] = DEVICE
    env["STEM_MODEL"] = MODEL
    env.setdefault("STEM_VOCAL_FALLBACK_MODEL", "htdemucs")
    command = [sys.executable, str(WORKER), str(source_path), str(job_dir), job_id]
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
        for line in proc.stdout:
            line = line.strip()
            if line:
                old = jobs.get(job_id, {})
                progress = min(94, max(8, int(old.get("progress", 8)) + 2))
                update_job(job_id, progress=progress, message=line[-350:])
        code = proc.wait()
        if code != 0:
            raise RuntimeError("Audio worker failed. Check the Colab output for details.")
        zip_path = job_dir / "stem-results.zip"
        manifest_path = job_dir / "deliverables" / "manifest.json"
        if not zip_path.is_file() or not manifest_path.is_file():
            raise RuntimeError("Worker completed without the expected result files.")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        results = []
        for item in manifest.get("stems", []):
            results.append({
                "name": item["name"],
                "duration_seconds": item.get("duration_seconds"),
                "wav": f"/api/jobs/{job_id}/audio/{item['wav']}",
                "mp3": f"/api/jobs/{job_id}/audio/{item['mp3']}",
                "diagnostics": item.get("signal_diagnostics", {})
            })
        mix = manifest.get("mix")
        if mix:
            results.append({
                "name": "stem-sum preview",
                "duration_seconds": mix.get("duration_seconds"),
                "wav": f"/api/jobs/{job_id}/audio/{mix['wav']}",
                "mp3": f"/api/jobs/{job_id}/audio/{mix['mp3']}",
                "note": mix.get("note", "")
            })
        update_job(job_id, status="completed", progress=100, message="Your audio results are ready.", manifest=manifest, results=results)
    except Exception as exc:
        update_job(job_id, status="failed", progress=100, message=str(exc), error=str(exc))

@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "STEM Colab Bridge", "device": DEVICE, "model": MODEL, "authenticated": bool(TOKEN)})

@app.post("/api/jobs")
def create_job():
    denied = require_auth()
    if denied: return denied
    if "audio" not in request.files:
        return jsonify({"error": "Choose an audio file first."}), 400
    uploaded = request.files["audio"]
    filename = secure_filename(uploaded.filename or "audio.mp3")
    ext = Path(filename).suffix.lower()
    if ext not in allowed:
        return jsonify({"error": "Unsupported audio type. Use MP3, WAV, FLAC, M4A, AAC, OGG or OPUS."}), 400
    job_id = uuid.uuid4().hex
    job_dir = ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    source_path = job_dir / ("original" + ext)
    uploaded.save(source_path)
    if source_path.stat().st_size == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        return jsonify({"error": "The uploaded file is empty."}), 400
    with lock:
        jobs[job_id] = {"id": job_id, "name": filename, "status": "queued", "progress": 2, "message": "Upload received by Colab."}
    threading.Thread(target=process_job, args=(job_id, source_path, job_dir), daemon=True).start()
    return jsonify({"id": job_id, "status": "queued", "statusUrl": f"/api/jobs/{job_id}"}), 202

@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    denied = require_auth()
    if denied: return denied
    with lock:
        job = dict(jobs.get(job_id, {}))
    if not job: return jsonify({"error": "Job not found. The Colab runtime may have restarted or expired."}), 404
    return jsonify({k: v for k, v in job.items() if k not in ("manifest", "error")})

@app.get("/api/jobs/<job_id>/results")
def get_results(job_id):
    denied = require_auth()
    if denied: return denied
    with lock:
        job = dict(jobs.get(job_id, {}))
    if not job or job.get("status") != "completed":
        return jsonify({"error": "Results are not ready."}), 404
    return jsonify({"manifest": job.get("manifest"), "results": job.get("results", [])})

@app.get("/api/jobs/<job_id>/audio/<path:filename>")
def get_audio(job_id, filename):
    denied = require_auth()
    if denied: return denied
    safe = Path(filename).name
    with lock:
        job = dict(jobs.get(job_id, {}))
    if not job or job.get("status") != "completed": abort(404)
    job_dir = ROOT / job_id / "deliverables"
    manifest = job.get("manifest", {})
    permitted = set()
    for stem in manifest.get("stems", []):
        permitted.update([stem.get("wav"), stem.get("mp3")])
    mix = manifest.get("mix") or {}
    permitted.update([mix.get("wav"), mix.get("mp3")])
    if safe not in permitted: abort(404)
    path = job_dir / safe
    if not path.is_file(): abort(404)
    return send_file(path, as_attachment=False, conditional=True)

@app.get("/api/jobs/<job_id>/download")
def download(job_id):
    denied = require_auth()
    if denied: return denied
    with lock:
        job = dict(jobs.get(job_id, {}))
    path = ROOT / job_id / "stem-results.zip"
    if not job or job.get("status") != "completed" or not path.is_file():
        return jsonify({"error": "Result ZIP is not ready."}), 404
    return send_file(path, as_attachment=True, download_name="STEM-" + job.get("name", "results") + "-stems.zip")

if __name__ == "__main__":
    from werkzeug.serving import make_server
    server = make_server("0.0.0.0", int(os.environ.get("PORT", "8787")), app, threaded=True)
    print("STEM Colab bridge listening on port 8787", flush=True)
    server.serve_forever()
