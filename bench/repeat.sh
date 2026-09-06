#!/usr/bin/env bash
#
# Repeat the admission sweep and report the spread.
#
# A single p99 per rate is not a measurement above the knee. Consecutive sweeps
# on this host put 2500 req/s at 14.89ms and then 38.80ms, and had 3000 req/s
# come out better than 2500 -- which cannot be a property of the service. The
# tail there is contention on a shared machine, and reporting one draw from it
# as a number would be reporting noise.
#
# So run the sweep N times and report the median and the range. Where the range
# is tight the number means something; where it is wide, that is the finding.
#
# Usage: bench/repeat.sh [repeats] [duration] [rate ...]
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

REPEATS=${1:-3}; shift || true
DURATION=${1:-20}; shift || true
RATES=("$@"); [ ${#RATES[@]} -eq 0 ] && RATES=(250 500 1000 1500 2000 2500 3000)

OUT=bench/results/repeat
rm -rf "$OUT"; mkdir -p "$OUT"

for r in $(seq 1 "$REPEATS"); do
  echo "  sweep $r of $REPEATS ..."
  ./scripts/serve.sh restart >/dev/null 2>&1
  ./bench/sweep.sh "$DURATION" "${RATES[@]}" >/dev/null 2>&1
  for rate in "${RATES[@]}"; do
    cp "bench/results/rate-$rate.txt" "$OUT/run$r-rate-$rate.txt"
  done
  uptime >> "$OUT/load.txt"
done

python3 - "$OUT" "$REPEATS" "${RATES[@]}" <<'PY'
import re, sys, pathlib, statistics as st

out, repeats, *rates = sys.argv[1], int(sys.argv[2]), *sys.argv[3:]

def parse(path):
    """Read the reserve-latency row: the first data row under that heading."""
    txt = pathlib.Path(path).read_text()
    body = txt.split('reserve latency', 1)[1]
    for line in body.splitlines():
        f = line.split()
        if len(f) >= 8 and f[0].isdigit():
            return {'achieved': int(f[1]), 'p50': float(f[3]),
                    'p95': float(f[4]), 'p99': float(f[5])}
    raise ValueError(f'no data row in {path}')

def cell(vals):
    med = st.median(vals)
    lo, hi = min(vals), max(vals)
    return f'{med:.2f}', f'{lo:.2f}-{hi:.2f}'

print(f'\nAdmission decision cost, {repeats} sweeps, median and range across runs\n')
hdr = f"  {'offered':>8}  {'achieved':>8}  {'p50 med':>8}  {'p50 range':>12}  {'p95 med':>8}  {'p95 range':>12}  {'p99 med':>8}  {'p99 range':>14}  {'p99 spread':>10}"
print(hdr); print('  ' + '-' * (len(hdr) - 2))

for rate in rates:
    runs = [parse(f'{out}/run{r}-rate-{rate}.txt') for r in range(1, repeats + 1)]
    ach = int(st.median([r['achieved'] for r in runs]))
    p50m, p50r = cell([r['p50'] for r in runs])
    p95m, p95r = cell([r['p95'] for r in runs])
    p99s = [r['p99'] for r in runs]
    p99m, p99r = cell(p99s)
    spread = max(p99s) / max(min(p99s), 1e-9)
    print(f'  {rate:>8}  {ach:>8}  {p50m:>8}  {p50r:>12}  {p95m:>8}  {p95r:>12}  {p99m:>8}  {p99r:>14}  {spread:>9.1f}x')

print('\n  p99 spread is max/min across sweeps. A figure near 1 means the number is')
print('  a property of the service; a large one means it is a property of whatever')
print('  else the machine was doing, and should not be quoted as a result.\n')
PY
