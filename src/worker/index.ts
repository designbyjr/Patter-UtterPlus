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
 * Provides instant <10ms Edge health checks and non-blocking multi-DO load balancing.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Dynamic pool size & slots per container
    const configuredPoolSize = parseInt(env.CONTAINER_POOL_SIZE || "3", 10);
    const slotsPerContainer = parseInt(env.MAX_CONTAINER_CALL_SLOTS || "4", 10);

    // 1. Direct container targeting via query param (e.g. ?containerId=patter-pool-1)
    const requestedContainerId = url.searchParams.get("containerId");
    if (requestedContainerId) {
      const container = getContainer(env.INFERENCE_CONTAINER, requestedContainerId);
      return container.fetch(request);
    }

    // 2. Instant Edge Health Check (< 10ms response time — zero cold-start delay)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        edge: "online",
        provider: "cloudflare-containers",
        poolSize: configuredPoolSize,
        totalCapacitySlots: configuredPoolSize * slotsPerContainer,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    // 3. Non-Blocking Pool Capacity & Status Check (/capacity, /status)
    if (url.pathname === "/capacity" || url.pathname === "/status") {
      try {
        let activeContainerIds: string[] = [];

        if (env.PATTER_KV) {
          const list = await env.PATTER_KV.list({ prefix: "container:" });
          activeContainerIds = list.keys.map(k => k.name.replace("container:", ""));
        }

        if (activeContainerIds.length === 0) {
          activeContainerIds = Array.from({ length: configuredPoolSize }, (_, i) => `patter-pool-${i}`);
        }

        // Fast non-blocking fetch with 1.5s timeout per container instance
        const poolPromises = activeContainerIds.map(cId => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1500);

          const c = getContainer(env.INFERENCE_CONTAINER, cId);
          return c.fetch(new Request("http://localhost:8080/capacity", { signal: controller.signal }))
            .then(res => {
              clearTimeout(timeoutId);
              return res.ok ? res.json() as Promise<any> : null;
            })
            .catch(() => {
              clearTimeout(timeoutId);
              return null;
            });
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
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      } catch (err: any) {
        // Fast edge fallback
        return new Response(JSON.stringify({
          status: "healthy",
          edge: "online",
          poolSize: configuredPoolSize,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 4. Smart Call Session Routing (/media)
    const callSessionId = url.searchParams.get("call_session_id") || url.searchParams.get("CallSid") || "";
    let poolIndex = 0;

    if (callSessionId) {
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
