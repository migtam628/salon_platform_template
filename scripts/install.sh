#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd "$script_dir/.." && pwd)
cd "$project_dir"

mode=local
install_docker=false
for argument in "$@"; do
  case "$argument" in
    local|staging) mode="$argument" ;;
    --install-docker) install_docker=true ;;
    -h|--help)
      echo 'Usage: bash scripts/install.sh [local|staging] [--install-docker]'
      echo '  local   - local-only demo stack, persistent single-node Mongo replica set'
      echo '  staging - HTTPS, external managed MongoDB and Appwrite; requires config'
      echo '  --install-docker - opt in to installing official Docker packages on Ubuntu/Debian'
      exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

umask 077
mkdir -p .deploy
created=false
for kind in stack api; do
  target=".deploy/$mode-$kind.env"
  if [ ! -e "$target" ]; then
    install -m 600 "deploy/templates/$mode-$kind.env.example" "$target"
    created=true
  fi
done

read_value() {
  # Parse literal KEY=VALUE config; do not source a file containing secrets.
  awk -v key="$2" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

stack_env=".deploy/$mode-stack.env"
api_env=".deploy/$mode-api.env"
if [ "$(read_value "$stack_env" SALON_DEPLOY_MODE)" != "$mode" ]; then
  echo "SALON_DEPLOY_MODE must be $mode in $stack_env" >&2
  exit 1
fi

if [ "$mode" = staging ]; then
  domain=$(read_value "$stack_env" SALON_SITE_ADDRESS)
  if [ "$created" = true ] || [ -z "$domain" ] || [[ "$domain" == *.example.com ]] || [[ "$domain" == *://* ]] || [[ "$domain" == *:* ]] || [[ "$domain" != *.* ]]; then
    echo 'Staging configuration created or incomplete. No services were started.' >&2
    echo "Edit $stack_env with a real staging domain and browser Appwrite values." >&2
    echo "Edit $api_env with HTTPS origins, separate staging database, Appwrite and admin IDs." >&2
    echo 'Then run this installer again; it will verify configuration before starting.' >&2
    exit 2
  fi
  if [ "$(read_value "$stack_env" VITE_DEMO_MODE)" != false ] ||
     [ "$(read_value "$api_env" NODE_ENV)" != production ] ||
     [ "$(read_value "$api_env" DEMO_MODE)" != false ] ||
     [ "$(read_value "$api_env" WEB_ORIGIN)" != "https://$domain" ] ||
     [ "$(read_value "$api_env" PUBLIC_WEB_URL)" != "https://$domain" ]; then
    echo 'Staging requires matching HTTPS domain and DEMO_MODE=false everywhere.' >&2
    exit 1
  fi
  if [ "$(read_value "$stack_env" VITE_APPWRITE_ENDPOINT)" != "$(read_value "$api_env" APPWRITE_ENDPOINT)" ] ||
     [ "$(read_value "$stack_env" VITE_APPWRITE_PROJECT_ID)" != "$(read_value "$api_env" APPWRITE_PROJECT_ID)" ]; then
    echo 'Browser and API Appwrite endpoint/project must match.' >&2
    exit 1
  fi
  mongo_uri=$(read_value "$api_env" MONGODB_URI)
  if [ -z "$mongo_uri" ] || [[ "$mongo_uri" == *'mongo:27017'* ]] || [[ "$mongo_uri" == *'localhost'* ]] || [[ "$mongo_uri" == *'127.0.0.1'* ]]; then
    echo 'Staging requires a dedicated external MongoDB cluster; local demo MongoDB is prohibited.' >&2
    exit 1
  fi
else
  if [ "$(read_value "$api_env" DEMO_MODE)" != true ] || [ "$(read_value "$stack_env" SALON_HTTP_BIND)" != 127.0.0.1 ]; then
    echo 'Local preview must use demo mode and a loopback-only HTTP binding.' >&2
    exit 1
  fi
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  if [ "$install_docker" = false ]; then
    echo 'Docker Engine and Compose are required.' >&2
    echo 'On Ubuntu/Debian run: bash scripts/install.sh local --install-docker' >&2
    echo 'For other operating systems, install Docker Desktop/Engine first.' >&2
    exit 1
  fi
  echo 'Installing Docker Engine and Compose (system package changes will require sudo).'
  bash "$script_dir/install-docker-ubuntu.sh"
fi

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null && sudo docker info >/dev/null 2>&1; then
    docker_command=(sudo docker)
  else
    echo 'Cannot access the Docker daemon. Start Docker or run with an authorized Docker user.' >&2
    exit 1
  fi
fi

compose=("${docker_command[@]}" compose --env-file "$stack_env" -f compose.yaml)
if [ "$mode" = local ]; then compose+=(-f compose.local.yaml); fi

# Avoid printing docker compose config, which expands sensitive env_file values.
"${compose[@]}" config --quiet
echo "Building isolated $mode images..."
"${compose[@]}" build

if [ "$mode" = staging ]; then
  echo 'Checking staging production config offline (no secret values displayed)...'
  "${compose[@]}" run --rm --no-deps api node apps/api/src/preflight.js
fi

"${compose[@]}" up --detach --no-build --wait --wait-timeout 180

if [ "$mode" = local ]; then
  http_port=$(read_value "$stack_env" SALON_HTTP_PORT)
  if command -v curl >/dev/null; then
    for attempt in $(seq 1 30); do
      if curl --fail --silent --max-time 3 "http://127.0.0.1:$http_port/api/ready" >/dev/null; then break; fi
      if [ "$attempt" -eq 30 ]; then
        echo 'Web gateway readiness failed. Inspect logs with scripts/stack.sh.' >&2
        exit 1
      fi
      sleep 1
    done
  fi
  echo "Salon preview ready: http://localhost:$http_port"
  echo 'The local demo is NOT safe to publish on the internet.'
else
  echo "Staging containers started. Verify DNS/HTTPS at https://$domain."
  echo 'Stripe, Appwrite, email, backup recovery and business workflows still need acceptance tests.'
fi
echo "Inspect services: bash scripts/stack.sh $mode status"
