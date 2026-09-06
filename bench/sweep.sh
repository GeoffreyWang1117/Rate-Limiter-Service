#!/usr/bin/env bash
#
# Drives Benchmark A across a range of offered rates and records where the
# capacity actually goes.
#
# Each rate runs in a fresh client process. Sweeping inside one long-lived
# generator lets earlier rates leave GC pressure and retained promise arrays
# behind, and the later, higher rates then inherit a client that is itself
# struggling -- which shows up in the results as a gateway that fell over. It
# did not; the load generator did.
#
# CPU is sampled from /proc as a delta over the run. `ps %cpu` reports an average
# over the whole life of the process, which for a long-running server is close to
# meaningless during a 12-second benchmark.
#
#   ./bench/sweep.sh [duration_s] [rate...]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

DURATION="${1:-12}"; shift || true
RATES=("$@")
[ ${#RATES[@]} -eq 0 ] && RATES=(250 500 1000 2000 3000 4000)

SVC_PID="$(tr -d '[:space:]' < .devstack/service.pid)"
REDIS_PID="$(tr -d '[:space:]' < .devstack/redis/redis.pid)"
CLK=$(getconf CLK_TCK)
OUT="$ROOT/bench/results"
mkdir -p "$OUT"

# utime+stime in jiffies for a pid.
cpu_ticks() { awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null || echo 0; }

echo "sweep: ${DURATION}s per rate, fresh client per rate"
echo "gateway pid $SVC_PID   redis pid $REDIS_PID   $(nproc) cores"
echo

printf '  %8s  %8s  %8s  %8s  %8s  %8s  %10s  %10s\n' \
  offered achieved p50 p95 p99 max 'gw cpu%' 'redis cpu%'
printf '  %8s  %8s  %8s  %8s  %8s  %8s  %10s  %10s\n' \
  -------- -------- -------- -------- -------- -------- ---------- ----------

for rate in "${RATES[@]}"; do
  gw0=$(cpu_ticks "$SVC_PID"); rd0=$(cpu_ticks "$REDIS_PID"); t0=$(date +%s.%N)

  log="$OUT/rate-${rate}.txt"
  npx tsx bench/bench-admission.ts --duration "$DURATION" --rates "$rate" > "$log" 2>&1

  t1=$(date +%s.%N); gw1=$(cpu_ticks "$SVC_PID"); rd1=$(cpu_ticks "$REDIS_PID")
  wall=$(echo "$t1 - $t0" | bc)
  gwcpu=$(echo "scale=1; ($gw1 - $gw0) / $CLK / $wall * 100" | bc)
  rdcpu=$(echo "scale=1; ($rd1 - $rd0) / $CLK / $wall * 100" | bc)

  # Pull the single data row out of the reserve-latency table.
  read -r achieved p50 p95 p99 max <<<"$(
    awk -v r="$rate" '$1 == r && NF >= 10 { print $2, $4, $5, $6, $8; exit }' "$log"
  )"

  printf '  %8s  %8s  %8s  %8s  %8s  %8s  %9s%%  %9s%%\n' \
    "$rate" "${achieved:-?}" "${p50:-?}" "${p95:-?}" "${p99:-?}" "${max:-?}" "$gwcpu" "$rdcpu"
done

echo
echo "CPU% is of one core. Node serves HTTP on a single thread, so a gateway"
echo "figure approaching 100 means this process is saturated and the next"
echo "replica -- not a faster machine -- is what adds capacity."
echo "Per-rate logs: bench/results/"
