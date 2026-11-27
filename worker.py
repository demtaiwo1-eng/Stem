import array, json, math, os, shutil, subprocess, sys, time, zipfile
from pathlib import Path

source = Path(sys.argv[1]).resolve()
job_dir = Path(sys.argv[2]).resolve()
job_id = sys.argv[3]
primary_model = os.environ.get("STEM_MODEL", "htdemucs_6s")
fallback_model = os.environ.get("STEM_VOCAL_FALLBACK_MODEL", "htdemucs")
device = os.environ.get("STEM_DEVICE", "cpu")
sep_root = job_dir / "separated"
out_dir = job_dir / "deliverables"
out_dir.mkdir(parents=True, exist_ok=True)

def run(args):
    print("Running: " + " ".join(str(x) for x in args), flush=True)
    subprocess.run(args, check=True)

def duration_of(file):
    result = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(file)], text=True)
    return float(result.strip())

def audio_metrics(file):
    # Decode to mono float PCM for consistent, dependency-light diagnostics.
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(file), "-f", "f32le",
        "-acodec", "pcm_f32le", "-ac", "1", "-ar", "22050", "pipe:1"
    ])
    samples = array.array("f")
    samples.frombytes(raw[:len(raw) - (len(raw) % samples.itemsize)])
    if not samples:
        return {"rms_dbfs": -120.0, "peak_dbfs": -120.0, "near_silence_percent": 100.0}
    squares = 0.0
    peak = 0.0
    silent = 0
    for value in samples:
        v = abs(value)
        squares += value * value
        peak = max(peak, v)
        if v < 0.000316:  # approximately -70 dBFS
            silent += 1
    rms = math.sqrt(squares / len(samples))
    db = lambda x: round(20 * math.log10(max(x, 1e-6)), 2)
    return {
        "rms_dbfs": db(rms),
        "peak_dbfs": db(peak),
        "near_silence_percent": round(100.0 * silent / len(samples), 2)
    }

def run_model(model):
    print("Starting separation model: " + model, flush=True)
    run([sys.executable, "-m", "demucs", "-n", model, "--device", device, "--out", str(sep_root), str(source)])
    track_dir = sep_root / model / source.stem
    if not track_dir.exists():
        candidates = list((sep_root / model).glob("*"))
        if not candidates:
            raise RuntimeError("Demucs did not produce a track folder for " + model)
        track_dir = candidates[0]
    return track_dir

def prepare_source():
    global source
    if source.suffix.lower() != ".zip":
        return []
    import zipfile
    extract_dir = job_dir / "uploaded-package"
    extract_dir.mkdir(parents=True, exist_ok=True)
    max_files, max_uncompressed = 100, 2 * 1024 * 1024 * 1024
    audio_exts = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}
    candidates, total = [], 0
    with zipfile.ZipFile(source) as package:
        entries = [x for x in package.infolist() if not x.is_dir()]
        if len(entries) > max_files:
            raise RuntimeError("ZIP contains too many files (maximum 100).")
        for entry in entries:
            name = entry.filename.replace("\\", "/")
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts or (parts and ":" in parts[0]):
                raise RuntimeError("ZIP contains an unsafe file path.")
            mode = (entry.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise RuntimeError("ZIP symbolic links are not accepted.")
            total += entry.file_size
            if total > max_uncompressed:
                raise RuntimeError("ZIP expands beyond the 2 GB processing limit.")
            if Path(name).suffix.lower() not in audio_exts:
                continue
            target = extract_dir / Path(name).name
            if target.exists():
                target = extract_dir / (str(len(candidates)) + "_" + target.name)
            with package.open(entry) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            candidates.append(target)
    if not candidates:
        raise RuntimeError("ZIP must contain at least one supported audio file (MP3, WAV, FLAC, M4A, AAC, OGG or OPUS).")
    mix_terms = ("mix", "master", "full", "original", "source", "song", "track")
    vocal_terms = ("vocal", "voice", "acapella", "a-cappella", "karaoke")
    def score(item):
        name = item.stem.lower()
        return (100 if any(term in name for term in mix_terms) else 0) - (200 if any(term in name for term in vocal_terms) else 0) + item.stat().st_size / 1e9
    source = max(candidates, key=score)
    print("ZIP package accepted:", len(candidates), "audio files; primary mix:", source.name, flush=True)
    # Preserve all supplied audio assets in the result package for review and alignment.
    assets_dir = out_dir / "provided-audio-assets"
    assets_dir.mkdir(exist_ok=True)
    for item in candidates:
        shutil.copy2(item, assets_dir / item.name)
    return candidates

def main():
    supplied_assets = prepare_source()
    duration = duration_of(source)
    print("Source duration: %.6f seconds" % duration, flush=True)
    primary_dir = run_model(primary_model)
    stems = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    primary_vocal = primary_dir / "vocals.wav"
    chosen_vocal = primary_vocal if primary_vocal.exists() else None
    vocal_checks = []
    if chosen_vocal:
        primary_metrics = audio_metrics(chosen_vocal)
        vocal_checks.append({"model": primary_model, **primary_metrics, "selected": True})
        print("Primary vocal diagnostics:", primary_metrics, flush=True)
        # Blank/near-silent vocal estimates trigger an independent 4-stem model pass.
        if primary_metrics["rms_dbfs"] < -48.0 or primary_metrics["near_silence_percent"] > 98.0:
            print("Vocal estimate looks unusually quiet; trying fallback model " + fallback_model, flush=True)
            try:
                fallback_dir = run_model(fallback_model)
                fallback_vocal = fallback_dir / "vocals.wav"
                if fallback_vocal.exists():
                    fallback_metrics = audio_metrics(fallback_vocal)
                    use_fallback = fallback_metrics["rms_dbfs"] > primary_metrics["rms_dbfs"] + 3.0
                    vocal_checks[0]["selected"] = not use_fallback
                    vocal_checks.append({"model": fallback_model, **fallback_metrics, "selected": use_fallback})
                    if use_fallback:
                        chosen_vocal = fallback_vocal
                    print("Fallback vocal diagnostics:", fallback_metrics, "| selected:", use_fallback, flush=True)
                else:
                    print("Fallback model did not produce a vocals.wav file.", flush=True)
            except Exception as error:
                print("Fallback model could not complete:", str(error), flush=True)
    else:
        print("Primary model did not produce vocals.wav; trying fallback model.", flush=True)
        try:
            fallback_dir = run_model(fallback_model)
            fallback_vocal = fallback_dir / "vocals.wav"
            if fallback_vocal.exists():
                chosen_vocal = fallback_vocal
                fallback_metrics = audio_metrics(fallback_vocal)
                vocal_checks.append({"model": fallback_model, **fallback_metrics, "selected": True})
        except Exception as error:
            print("Fallback vocal recovery failed:", str(error), flush=True)

    manifest = {
        "application": "STEM Audio Workbench",
        "job_id": job_id,
        "source_file": source.name,
        "source_duration_seconds": round(duration, 6),
        "model": primary_model,
        "separation_engine": "Demucs",
        "vocal_recovery": {
            "fallback_model": fallback_model,
            "attempted": len(vocal_checks) > 1,
            "candidates": vocal_checks,
            "selected_model": next((x["model"] for x in vocal_checks if x.get("selected")), None),
            "note": "A higher vocal RMS is only a diagnostic signal, not proof of cleaner vocals. Listen and compare against the original."
        },
        "stems": [],
        "mix": None,
        "limitations": [
            "Separated stems are model estimates, not recovered studio multitracks.",
            "If a vocal is absent or masked in the source, AI separation cannot guarantee recovery.",
            "Alternative-model selection uses signal level diagnostics; it does not automatically prove perceptual quality.",
            "Generated replacement music is not part of this separation pass and must be labelled separately.",
            "Backing vocals, ad-libs, individual drum pieces, synth layers, strings, brass, ambience and effects are not guaranteed to be isolated."
        ]
    }
    for stem in stems:
        wav = (chosen_vocal if stem == "vocals" else primary_dir / (stem + ".wav"))
        if not wav or not wav.exists():
            continue
        target_wav = out_dir / (stem + ".wav")
        target_mp3 = out_dir / (stem + ".mp3")
        common = ["-af", "aresample=44100:async=1:first_pts=0,apad", "-t", f"{duration:.6f}", "-ac", "2", "-ar", "44100"]
        run(["ffmpeg", "-y", "-i", str(wav), *common, "-c:a", "pcm_s16le", str(target_wav)])
        run(["ffmpeg", "-y", "-i", str(target_wav), "-c:a", "libmp3lame", "-b:a", "320k", str(target_mp3)])
        metrics = audio_metrics(target_wav)
        manifest["stems"].append({
            "name": stem, "wav": target_wav.name, "mp3": target_mp3.name,
            "duration_seconds": round(duration, 6), "sample_rate_hz": 44100,
            "channels": 2, "signal_diagnostics": metrics
        })
        print("Exported", stem, "|", metrics, flush=True)
    if not manifest["stems"]:
        raise RuntimeError("No expected stems were produced by the selected models.")

    # Optional conservative vocal polish. Keep the untouched recovered vocal as well.
    vocal_wav = out_dir / "vocals.wav"
    if vocal_wav.exists():
        enhanced_wav = out_dir / "vocals-enhanced.wav"
        enhanced_mp3 = out_dir / "vocals-enhanced.mp3"
        enhancement_filter = "highpass=f=75,lowpass=f=16500,acompressor=threshold=0.12:ratio=2.2:attack=15:release=180:makeup=1.2,alimiter=limit=0.95"
        run(["ffmpeg", "-y", "-i", str(vocal_wav), "-af", enhancement_filter, "-t", f"{duration:.6f}", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(enhanced_wav)])
        run(["ffmpeg", "-y", "-i", str(enhanced_wav), "-c:a", "libmp3lame", "-b:a", "320k", str(enhanced_mp3)])
        manifest["vocal_enhancement"] = {
            "wav": enhanced_wav.name, "mp3": enhanced_mp3.name,
            "duration_seconds": round(duration, 6),
            "processing": ["high-pass filtering", "high-frequency roll-off", "moderate compression", "peak limiting"],
            "note": "Conservative alternate processing, not source recovery, mastering, or a guarantee of professional vocal quality."
        }
        print("Created conservative enhanced-vocal alternate.", flush=True)
    else:
        manifest["vocal_enhancement"] = {"available": False, "note": "No vocal stem was available to enhance."}

    # Create an editable stem-sum preview, not a claim of a mastered or exact original mix.
    available = [out_dir / (name + ".wav") for name in stems if (out_dir / (name + ".wav")).exists()]
    mix_path = out_dir / "reconstructed-stem-sum-preview.wav"
    inputs = []
    for item in available:
        inputs.extend(["-i", str(item)])
    filter_graph = f"amix=inputs={len(available)}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", filter_graph, "-t", f"{duration:.6f}", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(mix_path)])
    mix_mp3 = out_dir / "reconstructed-stem-sum-preview.mp3"
    run(["ffmpeg", "-y", "-i", str(mix_path), "-c:a", "libmp3lame", "-b:a", "320k", str(mix_mp3)])
    manifest["mix"] = {
        "wav": mix_path.name, "mp3": mix_mp3.name,
        "duration_seconds": round(duration, 6),
        "type": "stem-sum preview",
        "note": "A simple sum of separated stems with peak limiting. It is not a professionally mastered mix and may differ from the original."
    }
    shutil.copy2(source, out_dir / ("original-reference" + source.suffix.lower()))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    readme = """# STEM result pack

This archive contains the original reference, model-separated audio stems, signal diagnostics, and a simple stem-sum preview. WAV files are stereo 44.1 kHz PCM; MP3 files are 320 kbps. Exports are trimmed/padded to the source duration.

## Vocal recovery
If the primary six-stem vocal estimate looked nearly silent, STEM also tries a second Demucs model and compares signal-level diagnostics. This is a recovery attempt, not a guarantee of a clean vocal. Check vocal_candidates in manifest.json and listen to the chosen stem against the original.

## Mix preview
reconstructed-stem-sum-preview is a simple sum of the available stems with peak limiting. It is not a professionally mixed or mastered song and may contain bleed or artifacts.

## Important limits
These are AI separation estimates, not original multitrack recordings. Missing source information cannot be recreated by separation alone. Generated replacement passages must be produced separately and labelled as generated material.
See manifest.json for models, duration and diagnostics.
"""
    (out_dir / "README.txt").write_text(readme, encoding="utf-8")
    zip_path = job_dir / "stem-results.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for item in sorted(out_dir.rglob("*")):
            if item.is_file():
                archive.write(item, arcname=item.relative_to(out_dir).as_posix())
    print("Finished. Result ZIP created.", flush=True)

if __name__ == "__main__":
    main()
