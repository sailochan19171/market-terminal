# Market Terminal: the Next.js site plus its background data jobs, in one container.
# The SQLite database lives on a persistent volume mounted at /data.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 MARKET_JOBS=off MARKET_ROOT=/tmp/build-root
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /tmp/build-root/data && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata sqlite3 \
  && rm -rf /var/lib/apt/lists/*
# ROOT=/ puts data/ (database, raw files, logs, lock files) on the /data volume.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Asia/Kolkata MARKET_ROOT=/ PORT=3000
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
