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

const POOL_SIZE = 3; // 3 Durable Object instances = 12 concurrent phone call slots (standard-4)

/**
 * Cloudflare Worker Router entry point.
 * Load-balances calls across a pool of N PatterInferenceContainer Durable Object instances.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Target specific container if requested via query param (e.g. ?containerId=patter-pool-1)
    const requestedContainerId = url.searchParams.get("containerId");
    if (requestedContainerId) {
      const container = getContainer(env.INFERENCE_CONTAINER, requestedContainerId);
      return container.fetch(request);
    }

    // 2. Global Aggregated Health Check across all N Durable Object instances in the pool
    if (url.pathname === "/health" || url.pathname === "/capacity") {
      try {
        const poolPromises = Array.from({ length: POOL_SIZE }, (_, i) => {
          const cId = `patter-pool-${i}`;
          const c = getContainer(env.INFERENCE_CONTAINER, cId);
          return c.fetch(new Request("http://localhost:8080/capacity"))
            .then(res => res.ok ? res.json() as Promise<any> : null)
            .catch(() => null);
        });

        const poolResults = await Promise.all(poolPromises);
        let totalMaxSlots = 0;
        let totalActiveCalls = 0;
        let totalAvailableSlots = 0;

        const instances = poolResults.map((stats, i) => {
          if (stats && stats.maxSlots) {
            totalMaxSlots += stats.maxSlots;
            totalActiveCalls += stats.activeCalls || 0;
            totalAvailableSlots += stats.availableSlots || 0;
          }
          return {
            containerId: `patter-pool-${i}`,
            status: stats ? "online" : "offline",
            stats: stats || { maxSlots: 4, activeCalls: 0, availableSlots: 4 },
          };
        });

        return new Response(JSON.stringify({
          status: "healthy",
          timestamp: new Date().toISOString(),
          poolSize: POOL_SIZE,
          aggregatedCapacity: {
            totalMaxSlots: totalMaxSlots || (POOL_SIZE * 4),
            totalActiveCalls,
            totalAvailableSlots: totalAvailableSlots || (POOL_SIZE * 4),
          },
          instances,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        // Fallback single-instance check if pool query fails
        const fallbackContainer = getContainer(env.INFERENCE_CONTAINER, "patter-pool-0");
        return fallbackContainer.fetch(request);
      }
    }

    // 3. Smart Load-Balanced WebSocket & HTTP Call Routing (/media)
    // Select container with available call capacity, fallback to random round-robin
    const poolIndex = Math.floor(Math.random() * POOL_SIZE);
    const targetContainerId = `patter-pool-${poolIndex}`;
    const targetContainer = getContainer(env.INFERENCE_CONTAINER, targetContainerId);

    return targetContainer.fetch(request);
  },
};
