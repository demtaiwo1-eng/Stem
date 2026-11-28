import asyncio
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import imageio_ffmpeg

APP_ORIGINS = [x.strip() for x in os.getenv("STEM_ALLOWED_ORIGINS", "https://demtaiwo1-eng.github.io").split(",") if x.strip()]
MAX_UPLOAD = int(os.getenv("STEM_MAX_UPLOAD_MB", "250")) * 1024 * 1024
MAX_ZIP_TRACKS = int(os.getenv("STEM_MAX_ZIP_TRACKS", "20"))
MAX_ZIP_BYTES = int(os.getenv("STEM_MAX_ZIP_UNPACKED_MB", "1024")) * 1024 * 1024
MODEL = os.getenv("STEM_MODEL", "htdemucs_6s")
DEVICE = os.getenv("STEM_DEVICE", "cpu")
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}

app = FastAPI(title="STEM Local Audio Worker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=APP_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)

@app.middleware("http")
async def private_network_access(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

async def stream_archive(archive_path: Path, root: Path):
    try:
        with archive_path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                yield chunk
    finally:
        shutil.rmtree(root, ignore_errors=True)

def run_demucs(input_file: Path, output_dir: Path, output_format: str, track_label: str):
    command = [
        "python", "-m", "demucs",
        "--device", DEVICE,
        "-n", MODEL,
        "--out", str(output_dir),
        str(input_file),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=4 * 60 * 60)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("This track took too long on this device. Try a shorter track or use the cloud fallback.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "Demucs could not process this file.")[-3000:]
        raise RuntimeError(detail) from exc

    track_dir = output_dir / MODEL / input_file.stem
    if not track_dir.exists():
        candidates = list((output_dir / MODEL).glob("*"))
        if len(candidates) == 1 and candidates[0].is_dir():
            track_dir = candidates[0]
    if not track_dir.exists():
        raise RuntimeError("The processor finished but did not produce the expected stem files.")

    result_files = []
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    for stem in ["vocals", "drums", "bass", "guitar", "piano", "other"]:
        source = track_dir / f"{stem}.wav"
        if not source.exists():
            continue
        ext = "wav" if output_format == "wav" else "mp3"
        target = output_dir / f"{track_label}_{stem}.{ext}"
        if ext == "wav":
            shutil.copy2(source, target)
        else:
            subprocess.run(
                [ffmpeg, "-y", "-i", str(source), "-codec:a", "libmp3lame", "-q:a", "2", str(target)],
                check=True, capture_output=True, text=True, timeout=30 * 60,
            )
        result_files.append(target)
    if len(result_files) < 4:
        raise RuntimeError("The model returned fewer than four expected stems.")
    return result_files

@app.get("/health")
async def health():
    try:
        import demucs  # noqa: F401
        return {"ok": True, "engine": "Demucs", "model": MODEL, "device": DEVICE, "provider": "local"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.post("/separate")
async def separate(audio: UploadFile = File(...), outputFormat: str = Form("wav")):
    output_format = "mp3" if outputFormat.lower() == "mp3" else "wav"
    suffix = Path(audio.filename or "audio.wav").suffix.lower()
    if suffix not in AUDIO_EXTS and suffix != ".zip":
        raise HTTPException(400, "Choose a supported audio file or ZIP package.")
    temp = tempfile.mkdtemp(prefix="stem-local-")
    root = Path(temp)
    try:
        input_path = root / ("upload" + suffix)
        total = 0
        with input_path.open("wb") as destination:
            while chunk := await audio.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise HTTPException(413, "The upload exceeds the 250 MB limit.")
                destination.write(chunk)
        if total == 0:
            raise HTTPException(400, "The selected file is empty.")

        output_dir = root / "output"
        output_dir.mkdir()
        files = []
        if suffix == ".zip":
            extracted = root / "input-tracks"
            extracted.mkdir()
            with zipfile.ZipFile(input_path) as archive:
                candidates = [i for i in archive.infolist() if not i.is_dir() and Path(i.filename).suffix.lower() in AUDIO_EXTS]
                if not candidates:
                    raise HTTPException(400, "The ZIP contains no supported audio tracks.")
                if len(candidates) > MAX_ZIP_TRACKS:
                    raise HTTPException(400, f"The ZIP exceeds the {MAX_ZIP_TRACKS} track limit.")
                if sum(i.file_size for i in candidates) > MAX_ZIP_BYTES:
                    raise HTTPException(400, "The ZIP exceeds the uncompressed size limit.")
                tracks = []
                for index, info in enumerate(candidates, start=1):
                    safe_name = Path(PurePosixPath(info.filename).name).name
                    if not safe_name or safe_name.startswith("."):
                        continue
                    target = extracted / f"{index:02d}_{safe_name}"
                    with archive.open(info) as source, target.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
                    tracks.append((target, target.stem[:60]))
            for track, label in tracks:
                track_output = root / ("track-" + label)
                track_output.mkdir()
                files.extend(run_demucs(track, track_output, output_format, label))
        else:
            files = run_demucs(input_path, output_dir, output_format, Path(audio.filename or "audio").stem[:60])

        archive_path = root / "STEM-results.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5) as archive:
            for item in files:
                archive.write(item, item.name)
        return StreamingResponse(stream_archive(archive_path, root), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="STEM-results.zip"'})
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("STEM_WORKER_PORT", "8765")))
