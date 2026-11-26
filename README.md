# STEM Audio Workbench

A self-hostable browser application for AI-assisted song source separation. Upload a mix, follow the processing job, and download an archive of aligned WAV and MP3 stems.

## Run locally (Docker recommended)
Requirements: Docker Desktop or Docker Engine with Compose.

```bash
git clone https://github.com/demtaiwo1-eng/Stem.git
cd Stem
docker compose up --build
```

Open http://localhost:8787. Upload an MP3/WAV/FLAC/M4A/AAC/OGG/OPUS file (250 MB default limit), wait for separation, then download the ZIP. The first run downloads Demucs model weights. CPU processing works but can be slow and memory-intensive.

## Run without Docker
Install Node.js 20+, Python 3.10+, FFmpeg and ffprobe. Then:

```bash
npm install
python3 -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
npm start
```

Open http://localhost:8787.

## Output
The Demucs `htdemucs_6s` model estimates six broad sources: vocals, drums, bass, guitar, piano and other. Every exported stem is converted to stereo 44.1 kHz WAV (16-bit PCM) and MP3 (320 kbps), with source-duration alignment. The ZIP includes the original reference, manifest and usage notes.

## Important limitations
These are AI estimates, not original multitrack recordings. The model cannot guarantee separate lead/backing vocals, ad-libs, kick/snare/cymbals, individual synth/string/brass layers, or reverb/delay returns. Bleed and artifacts are possible; `other` is a residual accompaniment group.

## API
`GET /health`, `GET /api/capabilities`, `POST /api/jobs` (multipart field `audio`), `GET /api/jobs/:id`, `GET /api/jobs/:id/download`.

## Deployment and privacy
The Docker image can run on a Docker-capable host. Small free web tiers may sleep, time out, or run out of RAM; audio separation needs substantial CPU, memory and disk. Use persistent storage for `DATA_DIR`. This starter stores job state in memory, so restarts clear job status and temporary results. Add durable queue/database/object storage and authentication before public multi-user production. Uploaded audio is processed on the server you operate; do not upload music without permission.
