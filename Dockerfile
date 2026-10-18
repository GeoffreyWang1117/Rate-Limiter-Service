# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Dependencies are copied and installed before the source, so an edit to src/
# reuses the cached install layer instead of refetching the whole tree.
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ---- production dependencies ----------------------------------------------
# A separate stage so the runtime image gets a node_modules that never contained
# dev dependencies, rather than one pruned after the fact.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# PID 1 in a container does not reap children or forward signals by default, so
# SIGTERM from an orchestrator would never reach the graceful-shutdown handler
# and every deploy would end in a 30-second kill.
# Pinned to the version, not the Alpine package revision. It was
# `dumb-init=1.2.5-r3`, which read as reproducibility and behaved as a time
# bomb: Alpine's index carries only current revisions, so the day upstream
# rebuilt the package as -r4 the exact pin stopped resolving and every image
# build failed. It had been failing in CI since the first run -- the one job
# nobody looked at, because the tests beside it were green.
#
# `=~1.2.5` accepts any revision of 1.2.5 and still refuses a different
# version. The honest statement of what that buys: the same dumb-init release,
# not a byte-identical runtime. Byte-identical needs the base image pinned by
# digest and a frozen package snapshot, neither of which is here.
RUN apk add --no-cache 'dumb-init=~1.2.5' && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY --from=deps  --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs package.json ./

# Numeric, not `nodejs`: Kubernetes `runAsNonRoot` cannot verify a name and
# refuses to start the pod, so a named USER fails at deploy time rather than
# at build time.
USER 1001
ENV NODE_ENV=production

# Metrics are served on the main port. The image used to also EXPOSE 9090, a
# port nothing ever bound.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
