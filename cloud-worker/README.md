# STEM GitHub Actions CPU Worker

STEM now uses an on-demand GitHub-hosted CPU runner for open-source Demucs separation. No Google Cloud VM, Google Cloud billing account, GPU, or always-on server is required.

## Architecture

1. The STEM website uploads audio to the existing Render API.
2. Render stores the original upload and queued job in the existing Neon-backed private storage.
3. Render sends a GitHub `repository_dispatch` event when the optional `GITHUB_ACTIONS_TOKEN` is configured.
4. The GitHub Actions workflow starts a temporary Ubuntu CPU runner, downloads the audio through a short-lived signed URL, and runs Demucs.
5. The worker uploads the result archive through the authenticated Render worker API.
6. Render stores the stems in the existing private bucket; the customer previews and downloads them from STEM.

Existing Render, Neon database, object storage, job history, and customer UI are retained. The worker does not receive Neon credentials.

## Free-runner behavior and limits

- The workflow uses GitHub-hosted `ubuntu-latest` CPU runners and processes up to three queued jobs per run.
- It is triggered immediately by Render when the optional dispatch token is configured, and also performs a scheduled queue sweep every 30 minutes as a fallback.
- GitHub Actions has usage quotas and concurrency limits. Free minutes depend on whether the repository is public or private and the account's remaining monthly allowance. Check GitHub Actions billing/usage before accepting high-volume traffic.
- Jobs can wait in the queue if GitHub runner minutes are exhausted, Actions are disabled, or a workflow is already running.
- This is a free-tier prototype/low-volume processing design, not an unlimited production compute service. Demucs CPU processing can be slow, especially for long audio and ZIP batches.
- Workflow timeout is 350 minutes. Each individual track has a 4-hour processing timeout.
- The scheduled fallback runs twice an hour. If the dispatch token is omitted, a newly uploaded job may wait up to approximately 30 minutes for the next scheduled run.
- No Google Cloud resources are created and no Google Cloud billing is enabled by this workflow.

## One-time secrets

Create one random worker token privately. In Google Cloud Shell or another trusted terminal, run:

```sh
openssl rand -hex 32
```

Copy the generated value directly into both secret settings below. Never paste it into chat, source code, a GitHub issue, or a commit.

### Render environment variables

Open the Render service `stem-api` → Environment and set:

- `STEM_WORKER_TOKEN`: the generated random token.

Optional immediate dispatch (recommended):

- Create a GitHub fine-grained personal access token restricted to repository `demtaiwo1-eng/Stem`, with **Contents: Read and write** permission.
- Add it to Render as `GITHUB_ACTIONS_TOKEN`.
- The token is used only by the Render API to send the `stem-job-queued` repository dispatch event. The scheduled workflow remains as a fallback.

Do not replace existing Render or Neon credentials.

### GitHub Actions secret

Open the GitHub repository `demtaiwo1-eng/Stem` → Settings → Secrets and variables → Actions → New repository secret.

Create:

- Name: `STEM_WORKER_TOKEN`
- Value: the exact same random token entered in Render.

The worker workflow refuses to start if this secret is missing or shorter than 32 characters.

## Run and verify

1. Open the repository's **Actions** tab.
2. Select **STEM Free CPU Audio Worker**.
3. Choose **Run workflow** to test the worker manually.
4. Confirm the run completes. If the queue is empty, it should exit successfully after reporting that no jobs are waiting.
5. Upload a short audio file through the STEM website.
6. Confirm the job moves from queued to processing and then completed, and verify the stems can be previewed/downloaded.

Health endpoint: https://stem-api-o0ij.onrender.com/health

The health endpoint reports whether the worker token is configured and whether a runner has recently contacted the API. A runner is not permanently online; the website can still accept jobs while the runner is idle because jobs are queued for the next run.

## Worker configuration

- API: `https://stem-api-o0ij.onrender.com`
- Model: `htdemucs_6s`
- CPU threads: 2
- Runner: GitHub-hosted Ubuntu
- Job queue and private object storage: existing Neon-backed service
- Worker authentication: shared `STEM_WORKER_TOKEN` stored only in Render and GitHub Actions secrets

## Troubleshooting

- **Workflow says STEM_WORKER_TOKEN is missing:** add the same secret to the repository's Actions secrets and Render environment.
- **Uploads are accepted but remain queued:** check that GitHub Actions is enabled, the monthly runner quota is available, and the latest scheduled or dispatch workflow ran successfully.
- **Dispatch does not start immediately:** configure the optional Render `GITHUB_ACTIONS_TOKEN`; otherwise the 30-minute scheduled fallback will pick up the queue.
- **A job fails:** inspect the workflow logs. Large files and long tracks may exceed the free runner's time or memory limits.
- **Do not enable Google Cloud billing or create a Compute Engine VM for this setup.**
