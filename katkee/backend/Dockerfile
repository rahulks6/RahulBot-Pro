# syntax=docker/dockerfile:1
#
# Two-stage build. The backend has zero runtime npm dependencies (see
# package.json — everything under src/ uses only Node built-ins), so the
# final image only needs the compiled dist/ output, Node itself, and the
# `psql` CLI (db/psql.ts shells out to it instead of using a driver
# package — see that file's own docstring for why). Nothing here has been
# built or run inside an actual container in this sandbox (the Docker
# daemon isn't available to me here — see DEPLOYMENT.md); it's written
# against well-established, standard Dockerfile patterns and the backend's
# own real, tested npm scripts, but you should run `docker build` yourself
# before trusting it further, the same way every other untestable piece
# of this project has been flagged rather than assumed working.

FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-slim AS runtime

# postgresql-client provides the `psql` binary db/psql.ts and
# scripts/migrate.ts both shell out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV MEDIA_STORAGE_ROOT=/app/data/media

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

# Never run a production Node process as root.
RUN useradd --create-home --shell /usr/sbin/nologin katkee \
    && mkdir -p /app/data/media \
    && chown -R katkee:katkee /app
USER katkee

EXPOSE 4000

# Real liveness check (Phase 11 — pings the database, not a static 200).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
