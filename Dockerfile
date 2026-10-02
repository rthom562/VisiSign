# VisiSign — container image for the cloud build.
#
# Runs on anything that takes a container: Cloud Run, App Runner, ECS/Fargate,
# Kubernetes, Fly, Render, or `docker compose up` on a PC at the office. The
# image is provider-neutral; everything that differs between deployments is an
# environment variable (see .env.cloud.example).
#
# No build toolchain is needed, which is why this is a small Alpine image:
# every dependency is pure JavaScript (bcryptjs, pg) or built into Node
# (node:sqlite), so there is nothing to compile.
#
#   docker build -t visisign .
#   docker run -p 4000:4000 -e DATABASE_URL=postgres://... visisign

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app/backend

# Copy manifests only, so this layer is cached until dependencies change.
COPY backend/package*.json ./

# `npm ci` needs a lockfile; fall back to `npm install` so the image still
# builds in a checkout that has not committed one.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force


# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# tini reaps zombies and forwards signals, so SIGTERM from the platform reaches
# Node and the graceful shutdown in server.js actually runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4000 \
    APP_DIR=/data \
    VISISIGN_CONTAINER=true

WORKDIR /app

# Dependencies first (cached), then source.
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/package*.json ./backend/
COPY backend/server.js ./backend/
COPY backend/src ./backend/src
COPY frontend ./frontend

# /data holds anything writable: the SQLite file if this deployment uses one,
# locally-stored photos, and an optional .env. A cloud deployment with Postgres
# and a bucket never writes here, which is what lets the container stay
# read-only and disposable.
RUN mkdir -p /data && chown -R node:node /data

# Drop privileges. `node` is a non-root user that ships with the base image.
USER node

EXPOSE 4000

# Readiness, not liveness: this asks whether the database is actually reachable.
# Platforms with their own probes (Cloud Run, ALB target groups) use those
# instead and ignore this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/backend

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
