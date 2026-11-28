# STEM Audio Workbench

STEM is a browser-based audio source-separation workbench. The public interface is hosted at https://demtaiwo1-eng.github.io/stem.github.io/. This repository contains the Node.js API, durable job history, and private Neon storage integration.

## Free hybrid processing architecture

- Local-first processing: an open-source Demucs worker runs on the user's Windows computer. Source audio is sent directly from the browser to 127.0.0.1; it is not uploaded to STEM cloud storage before separation.
- Optional free cloud fallback: the frontend can connect to a compatible worker URL. The cloud-worker folder provides a Hugging Face ZeroGPU Space template. Free GPU usage is quota-limited and may be unavailable or sleep when idle.
- Node.js API on Render: creates job-history records and stores completed result archives and individual stems.
- Neon Postgres: keeps job state and result manifests. Existing job rows and historical result records are retained.
- Neon Object Storage: keeps completed results private and provides short-lived signed preview/download links.

No FAL SDK, endpoint, API key, or queue is used by the new processing path. Legacy FAL columns in the existing database are intentionally left untouched so old job records are not destructively migrated.

## Run the free local processor on Windows

1. Download the repository ZIP from GitHub and extract it.
2. Open the local-worker folder.
3. Double-click Start-STEM-Processor.bat.
4. On first run, the launcher installs open-source Demucs and its dependencies. This downloads PyTorch and audio-processing packages and can require several gigabytes of free disk space.
5. Keep the processor window open. Open STEM and refresh. The status should say the local processor is connected.
6. Upload a song or ZIP package and choose WAV or MP3.

The worker defaults to CPU mode for compatibility. CPU processing can take a long time, especially for long recordings. A compatible NVIDIA GPU can be enabled by setting STEM_DEVICE=cuda after installing the matching PyTorch build. No per-track FAL/API charge is incurred.

## Optional free cloud fallback

The cloud-worker directory contains the files for a Hugging Face Spaces Gradio ZeroGPU template. Create a new public ZeroGPU Space, copy cloud-worker/app.py, cloud-worker/requirements.txt and cloud-worker/README.md into the Space root, then set window.STEM_CLOUD_WORKER_URL in the frontend api-config.js to the Space's https://<space-name>.hf.space URL. The local worker is always tried first. ZeroGPU has free usage quotas, eligibility requirements and availability limits; it is not unlimited cloud compute.

## STEM Neon resources

- Project ID: gentle-pond-85461704
- Branch ID: br-calm-term-bd9di0xb
- Database: stem
- Private bucket: stem-audio-private
- Region: us-east-2

## Server configuration

Configure backend values only in Render's encrypted environment settings.

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | Neon Postgres connection string |
| AWS_ACCESS_KEY_ID | Neon Storage access key |
| AWS_SECRET_ACCESS_KEY | Neon Storage secret |
| AWS_ENDPOINT_URL_S3 | STEM branch S3 endpoint |
| AWS_REGION | us-east-2 |
| STEM_BUCKET | stem-audio-private |
| STEM_MODEL | htdemucs_6s |
| ALLOWED_ORIGIN | Allowed browser origins |

Never commit credentials, signed URLs or API keys. The Neon bucket must remain private.

## API

- GET /health — database and private storage readiness.
- GET /api/capabilities — free processing providers, model, stems and limits.
- POST /api/jobs/local — creates a durable job record without uploading source audio.
- POST /api/jobs/:id/local-result — stores the completed ZIP and individual stems.
- GET /api/jobs/:id — durable status and progress.
- GET /api/jobs/:id/results — result manifest with fresh signed stem URLs.
- GET /api/jobs/:id/download — streams the private ZIP archive.
- POST /api/jobs — backwards-compatible source upload endpoint; it does not invoke a paid processor.

## Output and limitations

Demucs produces estimates, not original multitrack recordings. Bleed and artifacts are possible. The six broad outputs are vocals, drums, bass, guitar, piano and other. The model does not guarantee separate lead/backing singers, ad-libs, individual drum pieces, every synth/string/brass part, or separate reverb and delay returns.

Before public launch, add user authentication, per-user job authorization, upload quotas, retention and cleanup policies, rate limiting, and abuse protection. CORS is not authentication. Keep the Neon bucket private and all secrets on the server.
