# STEM release automation

The release gate is implemented in `scripts/release-gate.mjs` and is exposed as `npm run release:gate`. GitHub Actions runs it from **Actions → STEM full release and live verification → Run workflow**.

## What it does

1. Checks Node.js 20+ and runs the backend syntax/dependency checks.
2. Runs the hosting provider's deployment command.
3. Updates `api-config.js` in `demtaiwo1-eng/stem.github.io` with the HTTPS API base URL and commits the change.
4. Waits for GitHub Pages to publish that configuration.
5. Checks the live API health and advertised capabilities.
6. Creates a small synthetic audio test file and ZIP, then submits real FAL jobs for WAV, MP3 and ZIP.
7. Waits for each job to finish, checks that all six stems exist, downloads every stem, and validates the result ZIP.

The workflow defaults the paid end-to-end test input to **false**. The workflow deliberately stops before deployment unless the operator explicitly selects `run_paid_e2e=true`, because real FAL inference may incur usage charges.

## GitHub Actions configuration

Set these repository **Actions secrets** in `demtaiwo1-eng/Stem`:

- `STEM_DEPLOY_COMMAND` — the hosting-provider CLI command that builds/deploys this backend. The command runs in the release runner with the runtime environment below.
- `STEM_DATABASE_URL` — the Neon PostgreSQL connection string for the STEM database.
- `STEM_AWS_ACCESS_KEY_ID` and `STEM_AWS_SECRET_ACCESS_KEY` — credentials for the private Neon object-storage bucket.
- `STEM_FAL_API_KEY` — server-side FAL key.
- `STEM_FRONTEND_GITHUB_TOKEN` — GitHub token with Contents: Read and write on `demtaiwo1-eng/stem.github.io`.

Set these repository **Actions variables**:

- `STEM_API_BASE` — the deployed backend's public HTTPS origin, without a trailing slash.
- `STEM_AWS_ENDPOINT_URL_S3` — the Neon object-storage endpoint.

The deployment command must configure the deployed service with the same database, storage and FAL environment values. It must also keep those values in the backend's secret/environment store; never put them in frontend files.

## Pass criteria

A release is successful only when the workflow ends with `RELEASE PASS`. Passing syntax checks alone is not a production pass. The live test confirms actual processing and downloads, but it does not replace separate load testing with a production-sized workload.
