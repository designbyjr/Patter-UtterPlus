import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  INFERENCE_CONTAINER: DurableObjectNamespace;
  MAX_CONTAINER_CALL_SLOTS?: string;
  CONTAINER_POOL_SIZE?: string;
  CAPACITY_HTTP_PORT?: string;
  PATTER_R2_BUCKET?: string;
  PATTER_R2_ENDPOINT?: string;
  PATTER_KV?: KVNamespace;
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
 * Dynamically discovers and load-balances calls across a pool of N PatterInferenceContainer instances.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Dynamic pool size: configured via wrangler.toml env.CONTAINER_POOL_SIZE or default 3
    const configuredPoolSize = parseInt(env.CONTAINER_POOL_SIZE || "3", 10);
    const slotsPerContainer = parseInt(env.MAX_CONTAINER_CALL_SLOTS || "4", 10);

    // 1. Direct target container routing via query param (e.g. ?containerId=patter-pool-1)
    const requestedContainerId = url.searchParams.get("containerId");
    if (requestedContainerId) {
      const container = getContainer(env.INFERENCE_CONTAINER, requestedContainerId);
      return container.fetch(request);
    }

    // 2. Dynamic Discovery & Aggregated Health Check across all active containers
    if (url.pathname === "/health" || url.pathname === "/capacity" || url.pathname === "/status") {
      try {
        // Discover container IDs: if Workers KV is configured, list active registered containers; else use configured pool
        let activeContainerIds: string[] = [];

        if (env.PATTER_KV) {
          const list = await env.PATTER_KV.list({ prefix: "container:" });
          activeContainerIds = list.keys.map(k => k.name.replace("container:", ""));
        }

        if (activeContainerIds.length === 0) {
          activeContainerIds = Array.from({ length: configuredPoolSize }, (_, i) => `patter-pool-${i}`);
        }

        const poolPromises = activeContainerIds.map(cId => {
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
          const cId = activeContainerIds[i];
          if (stats && stats.maxSlots) {
            totalMaxSlots += stats.maxSlots;
            totalActiveCalls += stats.activeCalls || 0;
            totalAvailableSlots += stats.availableSlots || 0;
          } else {
            totalMaxSlots += slotsPerContainer;
            totalAvailableSlots += slotsPerContainer;
          }
          return {
            containerId: cId,
            status: stats ? "online" : "standby",
            stats: stats || { maxSlots: slotsPerContainer, activeCalls: 0, availableSlots: slotsPerContainer },
          };
        });

        return new Response(JSON.stringify({
          status: "healthy",
          timestamp: new Date().toISOString(),
          discoveryMode: env.PATTER_KV ? "kv-dynamic" : "env-configured",
          poolSize: activeContainerIds.length,
          aggregatedCapacity: {
            totalMaxSlots: totalMaxSlots || (activeContainerIds.length * slotsPerContainer),
            totalActiveCalls,
            totalAvailableSlots: totalAvailableSlots || (activeContainerIds.length * slotsPerContainer),
          },
          instances,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        // Resilient fallback to primary pool instance
        const fallbackContainer = getContainer(env.INFERENCE_CONTAINER, "patter-pool-0");
        return fallbackContainer.fetch(request);
      }
    }

    // 3. Smart Call Routing (/media)
    // Hash incoming call session ID (if available) or select round-robin from configured pool
    const callSessionId = url.searchParams.get("call_session_id") || url.searchParams.get("CallSid") || "";
    let poolIndex = 0;

    if (callSessionId) {
      // Deterministic hash pinning so retries/reconnections hit the exact same container
      let hash = 0;
      for (let i = 0; i < callSessionId.length; i++) {
        hash = (hash << 5) - hash + callSessionId.charCodeAt(i);
        hash |= 0;
      }
      poolIndex = Math.abs(hash) % configuredPoolSize;
    } else {
      poolIndex = Math.floor(Math.random() * configuredPoolSize);
    }

    const targetContainerId = `patter-pool-${poolIndex}`;
    const targetContainer = getContainer(env.INFERENCE_CONTAINER, targetContainerId);

    return targetContainer.fetch(request);
  },
};
