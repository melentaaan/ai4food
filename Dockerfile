# AI4Food API. One process and one file — the file is the part that has to
# outlive the container, so DB_FILE points at a mounted volume.
FROM node:22-bookworm-slim AS build

# better-sqlite3 builds a native module; the toolchain is not needed at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DB_FILE=/data/ai4food.db

WORKDIR /srv
COPY --from=build /srv/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/src ./src
COPY server/ops ./ops

RUN mkdir -p /data && chown -R node:node /data /srv

USER node
VOLUME ["/data"]
EXPOSE 4000

# /ready answers only when the database answers, which is the difference
# between "restart me" and "stop sending me traffic".
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, which the server already handles.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
