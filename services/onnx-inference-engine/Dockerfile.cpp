# Multi-stage production Dockerfile for C++ Native ONNX Inference Engine on Cloudflare Containers

FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl ca-certificates libcurl4-openssl-dev libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DPATTER_BUILD_TESTS=OFF
RUN cmake --build build --config Release -j$(nproc)

FROM ubuntu:22.04 AS runner
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libcurl4 libssl3 libgomp1 zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/build/patter-inference-engine /app/patter-inference-engine
COPY --from=builder /app/build/_deps/onnxruntime/lib/libonnxruntime*.so* /usr/local/lib/

RUN ldconfig

# Verify dynamic library linkage
RUN ldd /app/patter-inference-engine

ENV MAX_CONTAINER_CALL_SLOTS=4
ENV CAPACITY_HTTP_PORT=8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080
CMD ["/app/patter-inference-engine"]
