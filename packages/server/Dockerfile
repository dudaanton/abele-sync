# Build from the repository root: docker build -f packages/server/Dockerfile .
# Node 22 LTS on Debian slim: glibc supports better-sqlite3 prebuilds. A build-only
# toolchain handles architectures/releases without one; runtime has no compiler.
# Pin the multi-platform index (2026-10-07), not an architecture-specific digest.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server
COPY packages/core packages/core
COPY packages/cli packages/cli
RUN npm run build -- --force \
    && chmod +x packages/cli/dist/index.js packages/server/dist/index.js packages/server/dist/admin-cli/index.js \
    && npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY LICENSE ./LICENSE
LABEL org.opencontainers.image.source="https://github.com/dudaanton/abele-sync" \
      org.opencontainers.image.licenses="GPL-3.0-only"
RUN mkdir -p /data/blobs /vault && chown -R node:node /data /vault
USER node

# Optional daemon-only entrypoint. No HTTP probe applies to a filesystem daemon.
FROM runtime AS daemon
ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
CMD ["--help"]

# Last stage is the default image and the release workflow's server target.
FROM runtime AS server
VOLUME /data
ENV ABELE_DATABASE_URL=sqlite:///data/abele.db \
    ABELE_BLOB_DIR=/data/blobs \
    ABELE_HOST=0.0.0.0 \
    ABELE_PORT=8787
EXPOSE 8787
# Liveness only: /healthz is unauthenticated and does not probe the database.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "const p=process.env.ABELE_PORT||8787;fetch(`http://127.0.0.1:${p}/healthz`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "packages/server/dist/index.js"]
