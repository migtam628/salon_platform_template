#!/usr/bin/env bash
set -euo pipefail

# Explicit opt-in from install.sh --install-docker. Never remove existing Docker
# packages, containers, networks, volumes or user data.
if [ ! -r /etc/os-release ]; then
  echo 'Cannot identify Linux distribution. Install Docker Engine and Compose manually.' >&2
  exit 1
fi
. /etc/os-release
if [[ "$ID" != ubuntu && "$ID" != debian ]]; then
  echo 'Automatic Docker installation supports Ubuntu/Debian only.' >&2
  exit 1
fi

if ! command -v apt-get >/dev/null || ! command -v dpkg >/dev/null; then
  echo 'apt and dpkg are required for automatic Docker installation.' >&2
  exit 1
fi

for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo "Existing package $package may conflict with the official Docker packages." >&2
    echo 'Resolve the conflict manually; no packages have been removed.' >&2
    exit 1
  fi
done

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

if ! command -v curl >/dev/null; then
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl
fi

run_root apt-get update
run_root apt-get install -y ca-certificates curl
run_root install -m 0755 -d /etc/apt/keyrings
temp_key=$(mktemp)
trap 'rm -f "$temp_key"' EXIT
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$temp_key"
run_root install -m 0644 "$temp_key" /etc/apt/keyrings/docker.asc

codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [ -z "$codename" ]; then
  echo 'Unable to determine distribution codename.' >&2
  exit 1
fi
arch=$(dpkg --print-architecture)
repo_contents=$(printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$ID" "$codename" "$arch")
if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' "$repo_contents" > /etc/apt/sources.list.d/docker.sources
else
  printf '%s\n' "$repo_contents" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
fi

run_root apt-get update
run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
echo 'Docker Engine and Docker Compose plugin installed from the official repository.'
echo 'Docker group access is not modified (it would grant root-equivalent privileges).'
