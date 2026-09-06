#!/usr/bin/env bash
#
# Sensitivity sweep for Benchmark B.
#
# The advantage adaptive reservation shows is not a constant. It is a function of
# how far a caller's declared ceiling sits above what generation actually
# produces, and that gap is an assumption about traffic, not something this
# repository measured. Reporting one number from one assumed distribution would
# be presenting a modelling choice as a finding.
#
# So sweep the assumption. Each row is a real run against the real gateway; only
# the output-length distribution driving it changes.
#
# Usage: bench/sweep-reservation.sh [output-median ...]
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

BASE=${BASE:-http://127.0.0.1:3055}
OUT=bench/results
mkdir -p "$OUT"

MEDIANS=("$@")
[ ${#MEDIANS[@]} -eq 0 ] && MEDIANS=(90 180 400 900 2000)

printf '\nBenchmark B sensitivity -- adaptive advantage vs assumed output length\n\n'
printf '  declared ceiling is fixed at 4096 tokens; only the median of the\n'
printf '  log-normal actually generated changes.\n\n'
printf '  %14s  %12s  %10s  %10s  %9s  %10s\n' \
  'output median' 'unused decl%' 'worst_case' 'adaptive' 'advantage' 'overrun %'
printf '  %14s  %12s  %10s  %10s  %9s  %10s\n' \
  '--------------' '------------' '----------' '----------' '---------' '----------'

for m in "${MEDIANS[@]}"; do
  log="$OUT/reservation-median-$m.txt"
  npx tsx bench/bench-reservation.ts --url "$BASE" --output-median "$m" > "$log" 2>&1

  unused=$(grep -oE '\(([0-9.]+)% of the declaration is never generated\)' "$log" \
           | grep -oE '[0-9.]+' | head -1)
  # Both tables have rows whose first field is the mode name, and so does the
  # "calibrating ..." progress line. Gate on the section header and require a
  # numeric second field, so progress output cannot be read as a result.
  wc_adm=$(awk '/how much of the burst/{f=1}
                f && $1=="worst_case" && $2 ~ /^[0-9]+$/ {print $2; exit}' "$log")
  ad_adm=$(awk '/how much of the burst/{f=1}
                f && $1=="adaptive" && $2 ~ /^[0-9]+$/ {print $2; exit}' "$log")
  over=$(awk '/what adaptive gives up/{f=1}
              f && $1=="adaptive" && $2 ~ /^[0-9]+$/ {print $3; exit}' "$log")
  adv=$(awk -v a="$ad_adm" -v w="$wc_adm" 'BEGIN{ if (w+0>0) printf "%.2f", a/w; else print "n/a" }')

  printf '  %14s  %12s  %10s  %10s  %8sx  %10s\n' \
    "$m" "${unused:-?}" "${wc_adm:-?}" "${ad_adm:-?}" "$adv" "${over:-?}"
done

printf '\n  raw runs: %s/reservation-median-*.txt\n\n' "$OUT"
