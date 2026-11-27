# STEM Audio Workbench

STEM is a browser-based audio source-separation workbench. The public interface is hosted on GitHub Pages at [STEM](https://demtaiwo1-eng.github.io/stem.github.io/). This repository contains the secure API coordinating FAL Demucs processing and Neon storage.

## Current architecture

- **GitHub Pages** — static public interface; no API keys or storage credentials are shipped to the browser.
- **Node.js API** — accepts audio uploads, creates durable jobs, submits FAL requests, polls job state and exposes results.
- **FAL `fal-ai/demucs`** — hosted six-source separation using `htdemucs_6s`.
- **Neon Postgres** — durable job state, queue identifiers, progress and result manifest.
- **Neon Object Storage** — private originals, individual separated stems and downloadable ZIP archives.

The API does not start a local Python Demucs worker. Hosted FAL inference handles separation, so the API container does not need PyTorch, Python, CUDA or FFmpeg.

## STEM Neon resources

- Project: `stem-audio-workbench`
- Project ID: `gentle-pond-85461704`
- Branch ID: `br-calm-term-bd9di0xb`
- Database: `stem`
- Private bucket: `stem-audio-private`
- Region: `us-east-2`

## Server configuration

Copy `.env.example` to a private `.env` file for self-hosting. Configure values only in the backend host's encrypted secret manager.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string |
| `AWS_ACCESS_KEY_ID` | Neon Storage access key |
| `AWS_SECRET_ACCESS_KEY` | Neon Storage secret |
| `AWS_ENDPOINT_URL_S3` | STEM branch S3 endpoint |
| `AWS_REGION` | `us-east-2` |
| `STEM_BUCKET` | `stem-audio-private` |
| `FAL_API_KEY` | FAL API key; backend only |
| `FAL_MODEL` | `fal-ai/demucs` |
| `STEM_MODEL` | `htdemucs_6s` |
| `ALLOWED_ORIGIN` | Comma-separated allowed browser origins |

Never commit `.env`, credentials, signed URLs or API keys. The Neon bucket must remain private.

## Processing lifecycle

1. The browser uploads one audio file or a ZIP package to `POST /api/jobs`. ZIP files are safely inspected and extracted to audio tracks (maximum 20 tracks and 1 GB total uncompressed audio by default).
2. The API stores the original in the private Neon bucket and inserts a `stem_jobs` record.
3. The API creates a short-lived signed read URL for the private original and submits it to FAL's queue API.
4. The API persists FAL's request, status and response URLs.
5. The API polls queued jobs and recovers pending work after an API restart.
6. On completion, the API downloads the six FAL output files, copies them to private Neon storage, creates a ZIP archive and saves a result manifest.
7. The browser fetches fresh one-hour signed preview/download links from `GET /api/jobs/:id/results`; the complete ZIP is available at `GET /api/jobs/:id/download`.

Each ZIP track is submitted as its own FAL request. STEM combines all resulting stems into one downloadable ZIP while keeping track folders separate. The FAL request uses the six `htdemucs_6s` stems: vocals, drums, bass, other, guitar and piano. Each request produces the selected output format (WAV or MP3); the API does not claim to generate both formats from a single inference.

## API

- `GET /health` — database, storage configuration and FAL configuration status.
- `GET /api/capabilities` — model, stem names, formats and upload limit.
- `POST /api/jobs` — multipart upload; field `audio`, optional `outputFormat=wav|mp3`.
- `GET /api/jobs/:id` — durable status and progress.
- `GET /api/jobs/:id/results` — result manifest with fresh signed stem URLs.
- `GET /api/jobs/:id/download` — streams the private ZIP archive.

## Run in Docker

Requirements: Docker and the environment values above.

```bash
git clone https://github.com/demtaiwo1-eng/Stem.git
cd Stem
cp .env.example .env
# Add actual credentials to .env locally; never commit it.
docker compose up --build
```

The API listens on `http://localhost:8787`.

## Output and limitations

The six outputs are AI estimates, not original multitrack recordings. Bleed and artifacts are possible. The model does not guarantee separate lead/backing singers, ad-libs, individual drum pieces, every synth/string/brass part, or separate reverb and delay returns.

Before public launch, add user authentication, per-user job authorization, upload quotas, retention and cleanup policies, rate limiting, and abuse protection. CORS is not authentication. Keep the Neon bucket private and keep all secrets on the server.
