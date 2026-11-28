import io
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

import requests
import torch

API_BASE = os.environ["STEM_API_BASE"].rstrip("/")
TOKEN = os.environ["STEM_WORKER_TOKEN"]
POLL_SECONDS = int(os.getenv("STEM_POLL_SECONDS", "8"))
MODEL_DEFAULT = os.getenv("STEM_MODEL", "htdemucs_6s")
MAX_TRACKS = int(os.getenv("STEM_MAX_TRACKS", "20"))
MAX_UNPACKED_BYTES = int(os.getenv("STEM_MAX_UNPACKED_BYTES", str(1024 * 1024 * 1024)))
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}
STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
SESSION = requests.Session()
SESSION.headers.update({"Authorization": f"Bearer {TOKEN}", "User-Agent": "STEM-Oracle-Free-Worker/1.0"})
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stem-worker")
torch.set_num_threads(max(1, int(os.getenv("STEM_CPU_THREADS", "2"))))


def api(method, path, **kwargs):
    response = SESSION.request(method, API_BASE + path, timeout=kwargs.pop("timeout", 60), **kwargs)
    response.raise_for_status()
    return response


def safe_track_name(value):
    name = Path(value).stem
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name).strip("._")
    return (cleaned or "track")[:100]


def download_input(job, target):
    response = requests.get(job["inputUrl"], stream=True, timeout=(30, 600))
    response.raise_for_status()
    with target.open("wb") as out:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                out.write(chunk)


def extract_tracks(source, job, work):
    tracks = []
    if job.get("sourceType") != "zip" and source.suffix.lower() != ".zip":
        if source.suffix.lower() not in AUDIO_EXTENSIONS:
            raise ValueError("Unsupported audio format.")
        return [source]
    total = 0
    with zipfile.ZipFile(source) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            relative = PurePosixPath(info.filename)
            if relative.is_absolute() or ".." in relative.parts:
                continue
            if relative.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            total += info.file_size
            if total > MAX_UNPACKED_BYTES:
                raise ValueError("ZIP exceeds the free worker's unpacked-size limit.")
            if len(tracks) >= MAX_TRACKS:
                raise ValueError(f"ZIP contains more than {MAX_TRACKS} audio tracks.")
            target = work / "inputs" / (f"{len(tracks):03d}-" + safe_track_name(relative.name) + relative.suffix.lower())
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            tracks.append(target)
    if not tracks:
        raise ValueError("ZIP contains no supported audio tracks.")
    return tracks


def process_track(track, output_dir, model, output_format, work, index, total):
    command = [
        sys.executable, "-m", "demucs", "--device", "cpu", "-j", "1",
        "-n", model, "--out", str(output_dir), str(track)
    ]
    env = os.environ.copy()
    env.update({"OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1"})
    log.info("Processing track %s of %s: %s", index, total, track.name)
    subprocess.run(command, check=True, timeout=int(os.getenv("STEM_TRACK_TIMEOUT_SECONDS", "14400")), env=env)
    result_dir = output_dir / model / track.stem
    if not result_dir.is_dir():
        raise RuntimeError("Demucs did not create its expected output directory.")
    track_dir = work / "pack" / safe_track_name(track.name)
    track_dir.mkdir(parents=True, exist_ok=True)
    found = 0
    for stem in STEMS:
        wav = result_dir / f"{stem}.wav"
        if not wav.exists():
            continue
        destination = track_dir / f"{safe_track_name(track.name)}_{stem}.{output_format}"
        if output_format == "wav":
            shutil.copy2(wav, destination)
        else:
            subprocess.run(
                ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(wav),
                 "-codec:a", "libmp3lame", "-q:a", "2", str(destination)],
                check=True, timeout=3600
            )
        found += 1
    if found < 4:
        raise RuntimeError(f"Demucs returned only {found} stems for {track.name}.")


def make_archive(work):
    archive_path = work / "STEM-results.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for item in sorted((work / "pack").rglob("*")):
            if item.is_file():
                archive.write(item, item.relative_to(work / "pack").as_posix())
    if archive_path.stat().st_size == 0:
        raise RuntimeError("The result archive is empty.")
    return archive_path


def report_failure(job_id, error):
    try:
        api("POST", f"/api/worker/jobs/{job_id}/fail", json={"error": str(error)[:900]}, timeout=30)
    except Exception:
        log.exception("Could not report failure for job %s", job_id)


def handle_job(job):
    job_id = job["id"]
    with tempfile.TemporaryDirectory(prefix="stem-oracle-") as temp:
        work = Path(temp)
        source = work / ("input" + (Path(job["name"]).suffix.lower() or ".audio"))
        download_input(job, source)
        api("POST", f"/api/worker/jobs/{job_id}/progress", json={"progress": 15, "message": "Audio downloaded. Preparing tracks for CPU separation."})
        tracks = extract_tracks(source, job, work)
        output_dir = work / "demucs-output"
        output_dir.mkdir()
        model = job.get("model") or MODEL_DEFAULT
        output_format = "mp3" if job.get("outputFormat") == "mp3" else "wav"
        for index, track in enumerate(tracks, start=1):
            progress = 20 + int((index - 1) / max(1, len(tracks)) * 55)
            api("POST", f"/api/worker/jobs/{job_id}/progress", json={"progress": progress, "message": f"Separating track {index} of {len(tracks)} with CPU Demucs."})
            process_track(track, output_dir, model, output_format, work, index, len(tracks))
        api("POST", f"/api/worker/jobs/{job_id}/progress", json={"progress": 82, "message": "Separation finished. Packaging the stems."})
        archive_path = make_archive(work)
        with archive_path.open("rb") as stream:
            response = SESSION.post(
                API_BASE + f"/api/worker/jobs/{job_id}/result",
                files={"archive": ("STEM-results.zip", stream, "application/zip")},
                timeout=(30, 1800)
            )
        response.raise_for_status()
        log.info("Job %s completed: %s tracks", job_id, len(tracks))


def main():
    if not API_BASE.startswith("https://") and not API_BASE.startswith("http://127.0.0.1"):
        raise SystemExit("STEM_API_BASE must be an HTTPS URL.")
    if not TOKEN or len(TOKEN) < 32:
        raise SystemExit("STEM_WORKER_TOKEN must be a random secret of at least 32 characters.")
    log.info("STEM Oracle Always Free CPU worker started; model=%s threads=%s", MODEL_DEFAULT, torch.get_num_threads())
    while True:
        try:
            response = SESSION.get(API_BASE + "/api/worker/jobs/next", timeout=60)
            if response.status_code == 204:
                time.sleep(POLL_SECONDS)
                continue
            response.raise_for_status()
            job = response.json()
            try:
                handle_job(job)
            except Exception as exc:
                log.exception("Job %s failed", job.get("id"))
                report_failure(job.get("id"), exc)
        except requests.RequestException:
            log.exception("Could not reach STEM API; retrying")
            time.sleep(max(POLL_SECONDS, 15))
        except Exception:
            log.exception("Unexpected worker loop error")
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
