#!/usr/bin/env bash
# Build and run the service against the local dev stack.
#   ./scripts/serve.sh start|stop|restart|logs
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
PIDFILE="$ROOT/.devstack/service.pid"
LOGFILE="$ROOT/.devstack/service.log"
PORT="${PORT:-3055}"

stop() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && echo "stopped pid $(cat "$PIDFILE")"
  else
    echo "not running"
  fi
  rm -f "$PIDFILE"
}

start() {
  mkdir -p "$ROOT/.devstack"
  npm run build >/dev/null || { echo "build failed"; npm run build; exit 1; }
  # shellcheck disable=SC1091
  source "$ROOT/scripts/devstack.env.sh"
  export PORT LOG_LEVEL="${LOG_LEVEL:-info}"
  nohup node dist/index.js > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && {
      echo "up on :$PORT (pid $(cat "$PIDFILE"))"; return 0; }
    sleep 0.25
  done
  echo "failed to become healthy; last log lines:"; tail -20 "$LOGFILE"; return 1
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 0.5; start ;;
  logs)    tail -f "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|restart|logs}"; exit 1 ;;
esac
