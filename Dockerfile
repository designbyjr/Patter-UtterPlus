# Multi-stage production Dockerfile for Patter Voice Infrastructure on Cloudflare Containers

FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
COPY libraries/typescript/package*.json ./libraries/typescript/
RUN cd libraries/typescript && npm ci

COPY . .
RUN cd libraries/typescript && npm run build

FROM node:22-slim AS runner
WORKDIR /app

# Install runtime C++ dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 zstd curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/libraries/typescript/dist ./dist
COPY package*.json ./
COPY libraries/typescript/package*.json ./libraries/typescript/
# Install production dependencies and copy to root /app/node_modules so Node resolves express & ws
RUN cd libraries/typescript && npm ci --omit=dev --omit=optional --no-audit --no-fund && cp -r node_modules /app/node_modules

ENV NODE_ENV=production
ENV PATTER_OTEL_ENABLED=1
ENV MAX_CONTAINER_CALL_SLOTS=4
ENV CAPACITY_HTTP_PORT=8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080
CMD ["node", "dist/index.js"]
