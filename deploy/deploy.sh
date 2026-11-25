#!/usr/bin/env bash
# Builds and starts the stack, waits for every healthcheck, then removes what
# the deploy replaced: dangling images and build cache older than a day. It
# never runs `system prune -a` or touches a volume: the data stays.
set -euo pipefail
cd "$(dirname "$0")"

docker compose build
docker compose up -d --wait

docker image prune -f
docker builder prune -f --filter until=24h
