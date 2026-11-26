#!/usr/bin/env sh
set -eu
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine or Docker Desktop first." >&2
  exit 1
fi
docker compose up --build
