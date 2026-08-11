# Multi-stage production Dockerfile for Patter Voice Infrastructure on Cloudflare Containers
# Explicitly targeting linux/amd64 architecture for Cloudflare Containers compatibility

FROM --platform=linux/amd64 node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
COPY libraries/typescript/package*.json ./libraries/typescript/
RUN cd libraries/typescript && npm ci

COPY . .
RUN cd libraries/typescript && npm run build

FROM --platform=linux/amd64 node:22-slim AS runner
WORKDIR /app

# Install C++ ONNX runtime dependencies (libgomp1), zstd, and curl for health check
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 zstd curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/libraries/typescript/dist ./dist
COPY package*.json ./
COPY libraries/typescript/package*.json ./libraries/typescript/
RUN cd libraries/typescript && npm ci --omit=dev

ENV NODE_ENV=production
ENV PATTER_OTEL_ENABLED=1
ENV MAX_CONTAINER_CALL_SLOTS=4
ENV CAPACITY_HTTP_PORT=8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080
CMD ["node", "dist/index.js"]
