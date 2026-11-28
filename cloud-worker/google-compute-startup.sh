#!/usr/bin/env bash
# Google Compute Engine startup script for the STEM CPU worker.
# Add a VM metadata value named stem-worker-token with the same secret configured
# privately in the Render API environment. Never commit the secret to GitHub.
set -Eeuo pipefail
exec > >(tee -a /var/log/stem-worker-startup.log) 2>&1

echo "[STEM] Installing Docker and preparing the worker"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git docker.io
systemctl enable --now docker

TOKEN="$(curl -fsS -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/stem-worker-token')"
if [ "${#TOKEN}" -lt 32 ]; then
  echo "[STEM] ERROR: stem-worker-token metadata must contain at least 32 characters."
  exit 1
fi

install -d -m 700 /etc/stem-worker
cat > /etc/stem-worker/worker.env <<EOF
STEM_API_BASE=https://stem-api-o0ij.onrender.com
STEM_WORKER_TOKEN=${TOKEN}
STEM_MODEL=htdemucs_6s
STEM_CPU_THREADS=2
STEM_POLL_SECONDS=8
STEM_TRACK_TIMEOUT_SECONDS=14400
EOF
chmod 600 /etc/stem-worker/worker.env
unset TOKEN

if [ ! -d /opt/stem-source/.git ]; then
  git clone --depth 1 https://github.com/demtaiwo1-eng/Stem.git /opt/stem-source
else
  git -C /opt/stem-source pull --ff-only
fi

docker build --pull -t stem-google-cloud-worker:latest /opt/stem-source/cloud-worker
docker rm -f stem-google-cloud-worker >/dev/null 2>&1 || true
docker run -d --name stem-google-cloud-worker --restart unless-stopped \
  --cpus=2 --memory=7g --pids-limit=512 \
  --env-file /etc/stem-worker/worker.env \
  stem-google-cloud-worker:latest

echo "[STEM] Worker container started. Check with: docker logs -f stem-google-cloud-worker"
