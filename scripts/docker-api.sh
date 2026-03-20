#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
SERVICE_NAME="${OPENTRANSLATE_API_SERVICE:-api}"
HOST_PORT="${OPENTRANSLATE_API_PORT:-8788}"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"
ACTION="${1:-up}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

wait_for_health() {
  require_cmd curl

  echo "waiting for API health at ${HEALTH_URL} ..."

  attempts=0
  max_attempts=60
  while [ "$attempts" -lt "$max_attempts" ]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "API is healthy: ${HEALTH_URL}"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  echo "API did not become healthy in time." >&2
  compose logs --tail 80 "$SERVICE_NAME" >&2 || true
  exit 1
}

require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

case "$ACTION" in
  up)
    compose up -d --build "$SERVICE_NAME"
    wait_for_health
    compose ps
    ;;
  build)
    compose build "$SERVICE_NAME"
    ;;
  down)
    compose down
    ;;
  restart)
    compose up -d --build "$SERVICE_NAME"
    wait_for_health
    compose ps
    ;;
  logs)
    compose logs -f "$SERVICE_NAME"
    ;;
  health)
    wait_for_health
    ;;
  ps)
    compose ps
    ;;
  *)
    cat >&2 <<EOF
usage: sh scripts/docker-api.sh [up|build|down|restart|logs|health|ps]

defaults:
  OPENTRANSLATE_API_PORT=${HOST_PORT}
  OPENTRANSLATE_API_SERVICE=${SERVICE_NAME}
EOF
    exit 1
    ;;
esac
