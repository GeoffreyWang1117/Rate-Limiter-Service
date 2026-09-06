#!/usr/bin/env bash
#
# A/B: what does per-request access logging cost the tail?
#
# The claim in the README used to rest on two numbers measured under conditions
# that could not later be reproduced, so it is measured here as a controlled
# pair instead: same code, same load, same machine, back to back, differing only
# in whether every request emits a log line.
#
#   B (per-request)  SLOW_REQUEST_LOG_MS=0 makes every request cross the "slow"
#                    threshold, so each one writes a structured line -- the
#                    behaviour the original request logger had unconditionally.
#   A (histogram)    the default, where per-request facts go to a histogram and
#                    only failures and genuine outliers are written.
#
# Usage: bench/logging-ab.sh [rate] [duration]
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

RATE=${1:-1500}
DURATION=${2:-20}
LOG=.devstack/service.log

run() {
  local label=$1
  ./scripts/serve.sh stop >/dev/null 2>&1 || true
  : > "$LOG"
  SLOW_REQUEST_LOG_MS=$2 LOG_LEVEL=info ./scripts/serve.sh start >/dev/null 2>&1
  local before after lines pid t0 t1 cpu
  before=$(wc -l < "$LOG")
  pid=$(tr -d '[:space:]' < .devstack/service.pid)
  # utime+stime from /proc as a delta over the run. `ps %cpu` is an average over
  # the whole life of the process, which for a server is close to meaningless.
  t0=$(awk '{print $14 + $15}' "/proc/$pid/stat")
  npx tsx bench/bench-admission.ts --rates "$RATE" --duration "$DURATION" > "/tmp/ab-${label// /_}.txt" 2>&1
  t1=$(awk '{print $14 + $15}' "/proc/$pid/stat")
  cpu=$(awk -v a="$t0" -v b="$t1" -v d="$DURATION" -v hz="$(getconf CLK_TCK)" \
        'BEGIN{ printf "%.0f%%", (b - a) / hz / d * 100 }')
  after=$(wc -l < "$LOG"); lines=$((after - before))
  local row
  row=$(awk '/reserve latency/{f=1} f&&$1+0>0&&NF>=8{print; exit}' "/tmp/ab-${label// /_}.txt")
  printf '  %-24s p50 %-7s p95 %-7s p99 %-8s  cpu %-6s  log lines %s\n' \
    "$label" "$(echo "$row" | awk '{print $4}')" "$(echo "$row" | awk '{print $5}')" \
    "$(echo "$row" | awk '{print $6}')" "$cpu" "$lines"
}

printf '\nPer-request logging A/B -- %s cycles/s for %ss, LOG_LEVEL=info\n\n' "$RATE" "$DURATION"
run "B per-request line" 0
run "A histogram (default)" 250
printf '\n  Serialisation and the write land on the thread that serves requests, so\n'
printf '  the logger competes directly with the work it describes.\n\n'
