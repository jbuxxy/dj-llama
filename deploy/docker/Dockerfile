# syntax=docker/dockerfile:1.7

# Global ARG -- must be before any FROM. Alpine default: fewer OS-package CVEs
# than slim. Override to the slim digest for the -debian variant.
ARG RUNTIME_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

# Deps stage -- all deps (dev + prod) for the builder. Cache-mount accelerates rebuilds.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

# Build stage -- reuses deps, produces dist/.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG DJLLAMA_GIT_SHA=dev
ARG DJLLAMA_CHANNEL=local
ENV DJLLAMA_GIT_SHA=${DJLLAMA_GIT_SHA}
ENV DJLLAMA_CHANNEL=${DJLLAMA_CHANNEL}
ENV NODE_ENV=production
RUN bun run build

# Deps-prod stage -- production-only deps, shared cache id.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps-prod
WORKDIR /app
COPY package.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --production

# Runtime stage -- defaults to alpine; override RUNTIME_IMAGE for the slim/debian variant.
# checkov:skip=CKV_DOCKER_7: Default and release override runtime images are version-and-digest pinned.
FROM ${RUNTIME_IMAGE}

# The backend bundle retains custom process.env reads, so preserve the build
# identity in the runtime image as well as the builder stage.
ARG DJLLAMA_GIT_SHA=dev
ARG DJLLAMA_CHANNEL=local
ENV DJLLAMA_GIT_SHA=${DJLLAMA_GIT_SHA}
ENV DJLLAMA_CHANNEL=${DJLLAMA_CHANNEL}

LABEL org.opencontainers.image.source="https://github.com/jbuxxy/dj-llama"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="dj-llama"
LABEL org.opencontainers.image.description="Plex-native music discovery, requests, and playlist generation"
LABEL org.opencontainers.image.vendor="jbuxxy"

WORKDIR /app

# Non-root user (bun base image ships with bun:bun at UID/GID 1000)

COPY --from=deps-prod /app/package.json /app/bun.lock ./
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY deploy/docker/healthcheck.sh /app/healthcheck.sh
RUN test -s /app/dist/scripts/rotate-encryption-key.js && \
    test -s /app/dist/scripts/prepare-rollback-backup.js && \
    chmod +x /app/healthcheck.sh

RUN mkdir -p /app/backups /app/data && chown bun:bun /app/backups /app/data
VOLUME ["/app/backups", "/app/data"]
ENV DB_PATH=/app/data

# Spotify integration has no working official-API path for this app anymore --
# Spotify's Feb 2026 policy blocks the entire Web API (OAuth and Client
# Credentials alike) for apps whose owner lacks Premium (see
# src/core/clients/spotify-scraper.ts). spotifyscraper bootstraps its own
# anonymous token from Spotify's public web-player infra instead, independent
# of any app we register. Isolated in its own venv so it never touches system
# pip. Alpine-specific; the slim/debian RUNTIME_IMAGE override isn't in active
# use (compose always builds alpine) so isn't handled here.
RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/spotify-scraper-venv && \
    /opt/spotify-scraper-venv/bin/pip install --no-cache-dir spotifyscraper==3.9.2
ENV SPOTIFY_SCRAPER_PYTHON=/opt/spotify-scraper-venv/bin/python3
COPY deploy/docker/spotify_bridge.py /app/spotify_bridge.py

# YouTube Music playlist import, same shape of problem as Spotify above: no
# simple public REST endpoint exists, so ytmusicapi's anonymous (no-login)
# playlist read is shelled out to via its own bridge script and venv --
# isolated from the spotify-scraper venv so the two scrapers' dependency
# trees never collide.
RUN python3 -m venv /opt/youtube-music-venv && \
    /opt/youtube-music-venv/bin/pip install --no-cache-dir ytmusicapi==1.12.1
ENV YOUTUBE_MUSIC_SCRAPER_PYTHON=/opt/youtube-music-venv/bin/python3
COPY deploy/docker/youtube_music_bridge.py /app/youtube_music_bridge.py

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/app/healthcheck.sh"]

USER bun
CMD ["bun", "dist/server/index.js"]
