#!/usr/bin/env bash
set -euo pipefail

# CI only: no customer data, external credentials, or network-facing listener.
# The production-dependency image is booted in safe, in-memory demo mode.
container_name='salon-api-ci-smoke'
base_url='http://127.0.0.1:4199'

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container_name" \
  --publish 127.0.0.1:4199:4000 \
  --env NODE_ENV=development \
  --env DEMO_MODE=true \
  --env PORT=4000 \
  salon-api:ci >/dev/null

if [ "$(docker exec "$container_name" id -u)" = '0' ]; then
  echo 'FAIL: API container unexpectedly runs as root' >&2
  exit 1
fi

for attempt in $(seq 1 40); do
  if curl --fail --silent --show-error --max-time 2 "$base_url/api/health" >/dev/null 2>&1 &&
     curl --fail --silent --show-error --max-time 2 "$base_url/api/ready" >/dev/null 2>&1; then
    echo 'PASS: API image runs as a non-root user and both health endpoints respond'
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container_name")" != true ]; then
    echo 'FAIL: API container exited before readiness' >&2
    docker logs "$container_name" >&2
    exit 1
  fi
  if [ "$attempt" -eq 40 ]; then
    echo 'FAIL: API did not become ready within 40 seconds' >&2
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 1
done
