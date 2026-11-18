#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"

mode=${1:-local}
action=${2:-status}
if [[ "$mode" != local && "$mode" != staging ]]; then
  echo 'Usage: bash scripts/stack.sh local|staging status|logs|stop|restart' >&2
  exit 2
fi
if [ ! -f ".deploy/$mode-stack.env" ]; then
  echo "No $mode installation configuration found. Run scripts/install.sh first." >&2
  exit 1
fi

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then docker_command=(sudo docker); fi
compose=("${docker_command[@]}" compose --env-file ".deploy/$mode-stack.env" -f compose.yaml)
if [ "$mode" = local ]; then compose+=(-f compose.local.yaml); fi

case "$action" in
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 --follow api web ;;
  stop) "${compose[@]}" down; echo 'Containers stopped; named data volumes were preserved.' ;;
  restart) "${compose[@]}" up --detach --wait --wait-timeout 180 ;;
  *) echo 'Usage: bash scripts/stack.sh local|staging status|logs|stop|restart' >&2; exit 2 ;;
esac
