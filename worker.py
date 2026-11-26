import json, os, shutil, subprocess, sys, time, zipfile
from pathlib import Path

source = Path(sys.argv[1]).resolve()
job_dir = Path(sys.argv[2]).resolve()
job_id = sys.argv[3]
model = os.environ.get("STEM_MODEL", "htdemucs_6s")
sep_root = job_dir / "separated"
out_dir = job_dir / "deliverables"
out_dir.mkdir(parents=True, exist_ok=True)

def run(args):
    print("Running: " + " ".join(str(x) for x in args), flush=True)
    subprocess.run(args, check=True)

def duration_of(file):
    result = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(file)], text=True)
    return float(result.strip())

def main():
    duration = duration_of(source)
    print("Checking audio duration and preparing Demucs separation…", flush=True)
    run(["python3", "-m", "demucs", "-n", model, "--device", os.environ.get("STEM_DEVICE", "cpu"), "--out", str(sep_root), str(source)])
    track_dir = sep_root / model / source.stem
    if not track_dir.exists():
        candidates = list((sep_root / model).glob("*"))
        if not candidates:
            raise RuntimeError("Demucs did not produce a track folder.")
        track_dir = candidates[0]
    stems = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    manifest = {
        "application": "STEM Audio Workbench",
        "job_id": job_id,
        "source_file": source.name,
        "source_duration_seconds": round(duration, 6),
        "model": model,
        "separation_engine": "Demucs",
        "stems": [],
        "limitations": [
            "The six outputs are model estimates, not guaranteed studio multitracks.",
            "Backing vocals, ad-libs, individual drum pieces, synth layers, strings, brass, ambience and effects are not guaranteed to be isolated separately.",
            "Some source material may bleed between stems; the 'other' stem contains accompaniment not assigned to the named source classes."
        ]
    }
    for stem in stems:
        wav = track_dir / (stem + ".wav")
        if not wav.exists():
            continue
        target_wav = out_dir / (stem + ".wav")
        target_mp3 = out_dir / (stem + ".mp3")
        # Force every export to the source's exact duration and a common stereo 44.1 kHz format.
        common = ["-af", "aresample=44100:async=1:first_pts=0,apad", "-t", f"{duration:.6f}", "-ac", "2", "-ar", "44100"]
        run(["ffmpeg", "-y", "-i", str(wav), *common, "-c:a", "pcm_s16le", str(target_wav)])
        run(["ffmpeg", "-y", "-i", str(target_wav), "-c:a", "libmp3lame", "-b:a", "320k", str(target_mp3)])
        manifest["stems"].append({"name": stem, "wav": target_wav.name, "mp3": target_mp3.name, "duration_seconds": round(duration, 6), "sample_rate_hz": 44100, "channels": 2})
        print("Exported " + stem + " in WAV and MP3.", flush=True)
    if not manifest["stems"]:
        raise RuntimeError("No expected stems were produced by the selected model.")
    shutil.copy2(source, out_dir / ("original-reference" + source.suffix.lower()))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    readme = """# STEM result pack

This archive contains the original reference recording and model-separated audio stems.
All exported stems are rendered as stereo 44.1 kHz WAV (16-bit PCM) and MP3 (320 kbps), trimmed/padded to the source recording duration.

## Stem guide
- vocals: vocal content estimated by the model (lead and backing vocals may remain mixed).
- drums: percussion/drum content estimated by the model.
- bass: bass-range musical content estimated by the model.
- guitar: guitar-like content estimated by the model.
- piano: piano-like content estimated by the model.
- other: remaining accompaniment and sounds not assigned to the named classes.

## Important limits
These are AI source-separation estimates, not original multitrack recordings. Bleed and artifacts are possible. The model does not promise separate lead/backing vocals, ad-libs, kick/snare/cymbals, individual synths, strings, brass, or reverb/delay returns. Listen to each stem and compare with the original before using it in a mix.
See manifest.json for model and duration metadata.
"""
    (out_dir / "README.txt").write_text(readme, encoding="utf-8")
    zip_path = job_dir / "stem-results.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for item in sorted(out_dir.iterdir()):
            archive.write(item, arcname=item.name)
    print("Finished. Result ZIP created.", flush=True)

if __name__ == "__main__":
    main()
