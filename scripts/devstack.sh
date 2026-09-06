#!/usr/bin/env bash
# Local dev stack: real Redis + real PostgreSQL, no Docker, no sudo.
# Binaries come from the `ratelimiter` conda env (conda-forge redis-server + postgresql).
#
#   ./scripts/devstack.sh up|down|status|psql|redis-cli|reset
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/.devstack"
CONDA_ENV="${RL_CONDA_ENV:-$HOME/miniconda3/envs/ratelimiter}"
BIN="$CONDA_ENV/bin"

REDIS_PORT="${REDIS_PORT:-6399}"
PG_PORT="${POSTGRES_PORT:-55432}"
PG_DATA="$STACK/pgdata"
PG_DB="${POSTGRES_DB:-rate_limiter}"
PG_USER="${POSTGRES_USER:-$(id -un)}"

log() { printf '\033[36m[devstack]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[devstack] %s\033[0m\n' "$*" >&2; exit 1; }

require_bins() {
  [ -x "$BIN/redis-server" ] || die "redis-server not found in $BIN. Run: conda create -y -n ratelimiter -c conda-forge redis-server postgresql"
  [ -x "$BIN/postgres" ]     || die "postgres not found in $BIN. Run: conda create -y -n ratelimiter -c conda-forge redis-server postgresql"
}

redis_up() {
  if "$BIN/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    log "redis already up on :$REDIS_PORT"; return
  fi
  mkdir -p "$STACK/redis"
  "$BIN/redis-server" \
    --port "$REDIS_PORT" \
    --dir "$STACK/redis" \
    --daemonize yes \
    --appendonly yes \
    --maxmemory 256mb \
    --maxmemory-policy allkeys-lru \
    --save '' \
    --pidfile "$STACK/redis/redis.pid" \
    --logfile "$STACK/redis/redis.log"
  for _ in $(seq 1 40); do
    "$BIN/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
    sleep 0.25
  done
  "$BIN/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 || die "redis failed to start; see $STACK/redis/redis.log"
  log "redis up on :$REDIS_PORT ($("$BIN/redis-server" --version | cut -d' ' -f1-3))"
}

pg_up() {
  if "$BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; then
    log "postgres already up on :$PG_PORT"; return
  fi
  if [ ! -d "$PG_DATA" ]; then
    log "initdb -> $PG_DATA"
    mkdir -p "$PG_DATA"
    "$BIN/initdb" -D "$PG_DATA" -U "$PG_USER" --auth=trust --encoding=UTF8 >"$STACK/initdb.log" 2>&1 \
      || die "initdb failed; see $STACK/initdb.log"
  fi
  "$BIN/pg_ctl" -D "$PG_DATA" -l "$STACK/postgres.log" \
    -o "-p $PG_PORT -k $STACK -c listen_addresses=127.0.0.1" -w start >/dev/null \
    || die "postgres failed to start; see $STACK/postgres.log"
  "$BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 \
    || "$BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DB"
  log "postgres up on :$PG_PORT (db=$PG_DB user=$PG_USER)"
}

case "${1:-up}" in
  up)
    require_bins; mkdir -p "$STACK"; redis_up; pg_up
    log "ready. export the matching env with:  source scripts/devstack.env.sh"
    ;;
  down)
    # Written out rather than as `A && B || C`: with that form C also runs when
    # A succeeded but B failed, so the script would report "not running" for a
    # server it had just failed to stop.
    if "$BIN/redis-cli" -p "$REDIS_PORT" shutdown nosave 2>/dev/null; then
      log "redis stopped"
    else
      log "redis not running"
    fi
    if [ -d "$PG_DATA" ] && "$BIN/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null 2>&1; then
      log "postgres stopped"
    else
      log "postgres not running"
    fi
    ;;
  status)
    "$BIN/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 && echo "redis    :$REDIS_PORT  UP" || echo "redis    :$REDIS_PORT  DOWN"
    "$BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null && echo "postgres :$PG_PORT UP" || echo "postgres :$PG_PORT DOWN"
    ;;
  reset)
    "$0" down || true
    rm -rf "$STACK"
    log "wiped $STACK"
    ;;
  psql)      shift; exec "$BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" "$@" ;;
  redis-cli) shift; exec "$BIN/redis-cli" -p "$REDIS_PORT" "$@" ;;
  *) die "usage: $0 {up|down|status|reset|psql|redis-cli}" ;;
esac
