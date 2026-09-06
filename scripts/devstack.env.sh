# shellcheck shell=bash
#
# source scripts/devstack.env.sh  -> point the service at the local dev stack
export REDIS_HOST=127.0.0.1
export REDIS_PORT=6399
export POSTGRES_HOST=127.0.0.1
export POSTGRES_PORT=55432
export POSTGRES_DB=rate_limiter
POSTGRES_USER="$(id -un)"
export POSTGRES_USER
export POSTGRES_PASSWORD=
