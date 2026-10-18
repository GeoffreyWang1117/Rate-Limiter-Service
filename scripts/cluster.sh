#!/usr/bin/env bash
# Local Redis Cluster: real cluster, no Docker, no sudo.
#
# Why this exists. The admission keys are laid out with a hash tag --
# `llm:{tenant|model}:tpm`, `:leases`, `:res` and so on -- so that every key a
# single admission decision touches hashes to one slot and the whole decision
# can stay one atomic Lua script. Until this script existed, that was a claim
# about key naming that no cluster had ever checked. A multi-key script whose
# keys land in different slots does not run slowly on a cluster; it is refused
# with CROSSSLOT. So the layout is either right or the service does not work at
# all there, and nothing in the repository distinguished those two cases.
#
#   ./scripts/cluster.sh up|down|status|cli|slots
#
# Ports: 7001.. for masters, then replicas. CLUSTER_REPLICAS=0 for masters only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/.devstack/cluster"
CONDA_ENV="${RL_CONDA_ENV:-$HOME/miniconda3/envs/ratelimiter}"
BIN="$CONDA_ENV/bin"

BASE_PORT="${CLUSTER_BASE_PORT:-7001}"
MASTERS="${CLUSTER_MASTERS:-3}"
REPLICAS="${CLUSTER_REPLICAS:-1}"
TOTAL=$(( MASTERS * (REPLICAS + 1) ))

log() { printf '\033[36m[cluster]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[cluster] %s\033[0m\n' "$*" >&2; exit 1; }

ports() { seq "$BASE_PORT" $(( BASE_PORT + TOTAL - 1 )); }

require_bins() {
  [ -x "$BIN/redis-server" ] || die "redis-server not found in $BIN"
  [ -x "$BIN/redis-cli" ]    || die "redis-cli not found in $BIN"
}

node_up() {
  local port=$1
  local dir="$STACK/$port"
  if "$BIN/redis-cli" -p "$port" ping >/dev/null 2>&1; then
    log "node :$port already up"; return
  fi
  mkdir -p "$dir"
  # noeviction, matching docker-compose.yml and the single-node dev stack. A
  # cluster that evicts live budget counters under memory pressure resets
  # tenants silently, and does it on one shard only, which is worse than doing
  # it everywhere: the budget then disagrees between shards.
  "$BIN/redis-server" \
    --port "$port" \
    --cluster-enabled yes \
    --cluster-config-file "$dir/nodes.conf" \
    --cluster-node-timeout 5000 \
    --dir "$dir" \
    --daemonize yes \
    --appendonly yes \
    --maxmemory 128mb \
    --maxmemory-policy noeviction \
    --save '' \
    --pidfile "$dir/redis.pid" \
    --logfile "$dir/redis.log"
}

wait_ready() {
  local port=$1
  local attempt
  for attempt in $(seq 1 50); do
    "$BIN/redis-cli" -p "$port" ping >/dev/null 2>&1 && return 0
    [ "$attempt" = 50 ] || sleep 0.1
  done
  die "node :$port never answered PING (see $STACK/$port/redis.log)"
}

cluster_formed() {
  "$BIN/redis-cli" -p "$BASE_PORT" cluster info 2>/dev/null \
    | grep -q '^cluster_state:ok'
}

up() {
  require_bins
  local port
  for port in $(ports); do node_up "$port"; done
  for port in $(ports); do wait_ready "$port"; done

  if cluster_formed; then
    log "cluster already formed"
  else
    log "forming cluster: $MASTERS masters, $REPLICAS replica(s) each"
    local addrs=()
    for port in $(ports); do addrs+=("127.0.0.1:$port"); done
    "$BIN/redis-cli" --cluster create "${addrs[@]}" \
      --cluster-replicas "$REPLICAS" --cluster-yes >/dev/null
    local attempt
    for attempt in $(seq 1 50); do
      cluster_formed && break
      [ "$attempt" = 50 ] && break
      sleep 0.2
    done
    cluster_formed || die "cluster did not reach state ok"
  fi
  status
}

down() {
  local port dir
  for port in $(ports); do
    dir="$STACK/$port"
    if [ -f "$dir/redis.pid" ]; then
      kill "$(cat "$dir/redis.pid")" 2>/dev/null || true
      rm -f "$dir/redis.pid"
    fi
  done
  log "cluster stopped (state kept in $STACK; use reset to discard)"
}

reset() { down; rm -rf "$STACK"; log "cluster state discarded"; }

status() {
  require_bins
  if ! "$BIN/redis-cli" -p "$BASE_PORT" ping >/dev/null 2>&1; then
    echo "cluster  DOWN"; return
  fi
  local state slots known
  state=$("$BIN/redis-cli" -p "$BASE_PORT" cluster info | awk -F: '/^cluster_state/{print $2}' | tr -d '\r')
  slots=$("$BIN/redis-cli" -p "$BASE_PORT" cluster info | awk -F: '/^cluster_slots_assigned/{print $2}' | tr -d '\r')
  known=$("$BIN/redis-cli" -p "$BASE_PORT" cluster info | awk -F: '/^cluster_known_nodes/{print $2}' | tr -d '\r')
  printf 'cluster  %s   slots %s/16384   nodes %s\n' "$state" "$slots" "$known"
  "$BIN/redis-cli" -p "$BASE_PORT" cluster shards >/dev/null 2>&1 &&
    "$BIN/redis-cli" -p "$BASE_PORT" --no-raw cluster nodes \
      | awk '{printf "  %-22s %-8s %s\n", $2, ($3 ~ /master/ ? "master" : "replica"), $9==""?"-":$9}'
}

# Where the keys of one tenant/model pair actually land. This is the whole
# argument for the hash tag, so it is one command rather than a paragraph.
slots() {
  require_bins
  local tenant="${1:-acme}" model="${2:-gpt-4}" key
  printf '\nkeys for tenant=%s model=%s\n\n' "$tenant" "$model"
  printf '  %-40s %7s  %s\n' key slot node
  printf '  %-40s %7s  %s\n' '----------------------------------------' '-------' '----'
  for suffix in tpm tpm:ts rpm rpm:ts leases res stats; do
    key="llm:{$tenant|$model}:$suffix"
    local slot node
    slot=$("$BIN/redis-cli" -p "$BASE_PORT" cluster keyslot "$key")
    node=$("$BIN/redis-cli" -p "$BASE_PORT" cluster nodes \
      | awk -v s="$slot" '$9 != "" && $3 ~ /master/ {
           split($9, r, "-"); if (s+0 >= r[1]+0 && s+0 <= r[2]+0) print $2 }')
    printf '  %-40s %7s  %s\n' "$key" "$slot" "${node:-?}"
  done
  echo
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  status) status ;;
  slots) shift; slots "$@" ;;
  cli) shift; exec "$BIN/redis-cli" -c -p "$BASE_PORT" "$@" ;;
  *) echo "usage: $0 up|down|reset|status|slots [tenant model]|cli" >&2; exit 2 ;;
esac
