# Benchmark artifacts

Raw output of the benchmark runs the numbers in the project README were read
from. Committed rather than ignored: a performance claim whose artifact is not
in the repository is a claim the reader has to take on trust, and the point of
this directory is that they do not have to.

| file | produced by |
|---|---|
| `rate-<n>.txt` | `./bench/sweep.sh 20 250 500 1000 1500 2000 2500 3000` — one file per offered rate, each from a fresh client process |
| `reservation-default.txt` | `npm run bench:reservation` at the documented workload |
| `reservation-median-<n>.txt` | `./bench/sweep-reservation.sh` — one file per assumed output-length median |

Each file records the machine it ran on at the bottom. They are regenerated when
the code that produces them changes, so a file older than the commit it sits in
means the table it backs has not been re-measured.

## What is real and what is assumed

The gateway, Redis, PostgreSQL, the Lua scripts, the HTTP path and the accounting
are all real in every run. No LLM is involved: admission decides before
generation starts, and `commit` reports what generation produced, so the
benchmark supplies those reports itself.

For the latency runs that is the whole story — the numbers are what the service
did. For the reservation runs the request *shape* is drawn from a log-normal
distribution chosen to resemble chat traffic, and the size of the effect depends
on that choice, which is why those are reported as a sweep across the assumption
rather than as one number. See "Known limits" in the project README.
