# STEM Audio Workbench

STEM is an open-source audio source-separation application. The public interface is hosted separately at [stem.github.io](https://demtaiwo1-eng.github.io/stem.github.io/). This repository contains the API and Demucs worker.

## Architecture

- **GitHub Pages** — public upload and result interface.
- **Neon Postgres** — durable job records, status, progress, result metadata and recovery after an API restart.
- **Neon Object Storage** — private storage for uploaded originals and completed ZIP archives.
- **Demucs + FFmpeg** — CPU/GPU worker that separates the audio and exports aligned WAV/MP3 files.

Neon does not execute the Demucs model. The Node.js service in this repository must run on a machine/container with Python, FFmpeg, sufficient memory, CPU/GPU and writable temporary disk.

## Neon resources already provisioned for this STEM project

- Project: `stem-audio-workbench`
- Project ID: `gentle-pond-85461704`
- Region: `aws-us-east-2`
- Default branch: `main`
- Branch ID: `br-calm-term-bd9di0xb`
- Database: `stem`
- Private bucket: `stem-audio-private`

The `public.stem_jobs` table and indexes have been created on the default branch. The server also checks/creates the table on startup.

## Required server environment

Create a private `.env` file from `.env.example` and supply the actual Neon values. Never commit `.env`, database passwords, or storage credentials.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres connection string |
| `AWS_ACCESS_KEY_ID` | Neon Object Storage credential ID |
| `AWS_SECRET_ACCESS_KEY` | Neon Object Storage secret |
| `AWS_ENDPOINT_URL_S3` | Branch-specific Neon S3 endpoint |
| `AWS_REGION` | `us-east-2` |
| `STEM_BUCKET` | `stem-audio-private` |
| `ALLOWED_ORIGIN` | GitHub Pages origin |

The storage endpoint is branch-scoped. Do not reuse credentials or endpoint values from EPHINTA. Use the STEM project's own credentials.

## Run with Docker

Requirements: Docker Engine/Desktop with Compose, and the Neon environment values above.

```bash
git clone https://github.com/demtaiwo1-eng/Stem.git
cd Stem
cp .env.example .env
# Edit .env with your Neon values
docker compose up --build
```

Open `http://localhost:8787`. The first separation downloads Demucs model weights. CPU processing is slow and memory-intensive.

## Run without Docker

Install Node.js 20+, Python 3.10+, FFmpeg and ffprobe.

```bash
npm install
python3 -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
npm start
```

## API

- `GET /health` — checks database connectivity and reports storage configuration.
- `GET /api/capabilities` — reports model, stems and storage features.
- `POST /api/jobs` — multipart form upload; field name `audio`.
- `GET /api/jobs/:id` — durable job status.
- `GET /api/jobs/:id/download` — streams the private result ZIP from Neon Object Storage.

The server persists job state in Postgres and uploads both the original recording and completed ZIP to the private bucket. On restart, jobs left in `processing` are returned to the queue and resumed from the stored original.

## Output

The Demucs `htdemucs_6s` model estimates six broad sources: vocals, drums, bass, guitar, piano and other. Every exported stem is stereo 44.1 kHz WAV (16-bit PCM) and MP3 (320 kbps), aligned to the source duration. The ZIP includes the original reference, manifest and usage notes.

These are AI estimates, not original multitrack recordings. Bleed and artifacts are possible. The model does not guarantee separate lead/backing vocals, ad-libs, individual drum pieces, synth/string/brass layers, or reverb/delay returns.

## Deployment and security

The API must be deployed on a Docker-capable host with enough RAM, CPU and disk for Demucs. Small free web tiers may sleep, time out, or run out of memory; do not promise production audio processing on a low-resource free tier. GitHub Pages is only the frontend.

Before accepting public uploads, add authentication, per-user authorization, upload quotas, retention/cleanup and abuse protection. CORS is not authentication. Keep the Neon bucket private and never put Neon credentials in browser code or Git.
