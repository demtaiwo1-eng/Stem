import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import gradio as gr
import imageio_ffmpeg
import spaces
import torch

MODEL = os.getenv("STEM_MODEL", "htdemucs_6s")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

@spaces.GPU
def separate(audio_path, output_format):
    if not audio_path:
        raise gr.Error("Upload an audio file first.")
    source = Path(audio_path)
    if source.suffix.lower() not in {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}:
        raise gr.Error("The free cloud fallback accepts one audio track at a time.")
    root = Path(tempfile.mkdtemp(prefix="stem-cloud-"))
    try:
        output = root / "output"
        output.mkdir()
        command = ["python", "-m", "demucs", "--device", DEVICE, "-n", MODEL, "--out", str(output), str(source)]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=3600)
        except subprocess.CalledProcessError as exc:
            raise gr.Error((exc.stderr or exc.stdout or "Demucs could not process this audio.")[-2500:])
        except subprocess.TimeoutExpired:
            raise gr.Error("The free cloud worker timed out. Try a shorter track or run the local processor.")
        track_dir = output / MODEL / source.stem
        if not track_dir.exists():
            raise gr.Error("Demucs did not return the expected stem files.")
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        files = []
        for stem in ["vocals", "drums", "bass", "guitar", "piano", "other"]:
            wav = track_dir / (stem + ".wav")
            if not wav.exists():
                continue
            ext = "wav" if output_format == "wav" else "mp3"
            target = root / (stem + "." + ext)
            if ext == "wav":
                shutil.copy2(wav, target)
            else:
                subprocess.run([ffmpeg, "-y", "-i", str(wav), "-codec:a", "libmp3lame", "-q:a", "2", str(target)], check=True, capture_output=True)
            files.append(target)
        if len(files) < 4:
            raise gr.Error("The model returned fewer than four stems.")
        archive = root / "STEM-results.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5) as z:
            for item in files:
                z.write(item, item.name)
        return str(archive)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise

with gr.Blocks(title="STEM Free Demucs Cloud Worker") as demo:
    gr.Markdown("# STEM · Free cloud fallback\nThis ZeroGPU worker is optional. Free GPU usage is quota-limited and availability is not guaranteed. For dependable free processing, use the local Windows processor.")
    audio = gr.File(label="Audio file", file_types=["audio"], type="filepath")
    output_format = gr.Radio(["wav", "mp3"], value="wav", label="Output format")
    run = gr.Button("Separate with Demucs", variant="primary")
    result = gr.File(label="Download separated stems")
    run.click(separate, inputs=[audio, output_format], outputs=result, api_name="separate")

demo.queue(max_size=8).launch()
