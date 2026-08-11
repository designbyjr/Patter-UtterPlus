import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  INFERENCE_CONTAINER: DurableObjectNamespace;
  MAX_CONTAINER_CALL_SLOTS: string;
  CAPACITY_HTTP_PORT: string;
  PATTER_R2_BUCKET: string;
  PATTER_R2_ENDPOINT: string;
}

/**
 * PatterInferenceContainer — Cloudflare Durable Object managing the C++ ONNX Inference Engine Docker container.
 * 
 * Auto-sleeps after 30 minutes of inactivity (`sleepAfter = "30m"`).
 * Proxies WebSocket streams (/media) and HTTP management requests (/health, /capacity) directly into the container.
 */
export class PatterInferenceContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";

  override async onStart() {
    console.log("[Patter] C++ ONNX Inference Container starting on Cloudflare Edge...");
  }

  override async onStop() {
    console.log("[Patter] C++ ONNX Inference Container sleeping (scale-to-zero)...");
  }
}

/**
 * Cloudflare Worker Router entry point.
 * Distributes requests across a pool of PatterInferenceContainer instances (up to 4 concurrent calls per container slot on standard-4).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Distributed pool routing across N container instances
    const poolIndex = Math.floor(Math.random() * 3);
    const containerId = `patter-pool-${poolIndex}`;
    const container = getContainer(env.INFERENCE_CONTAINER, containerId);

    // WebSocket upgrade for real-time PCM audio streaming (/media)
    if (url.pathname === "/media" && request.headers.get("Upgrade") === "websocket") {
      return container.fetch(request);
    }

    // Direct HTTP proxy for /health, /capacity, or other management routes
    return container.fetch(request);
  },
};
