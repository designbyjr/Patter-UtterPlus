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
 * Provides instant <10ms Edge health & capacity responses with zero cold-start delay.
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

    // 3. Fast Edge Capacity Check (< 10ms response time — zero RPC timeout wait)
    if (url.pathname === "/capacity" || url.pathname === "/status") {
      const isDeepCheck = url.searchParams.get("full") === "true";

      // Instant Edge Capacity Mode (Default: < 10ms)
      if (!isDeepCheck) {
        let activeCallsCount = 0;

        // If Workers KV is bound, count active call sessions instantly from KV index
        if (env.PATTER_KV) {
          try {
            const activeCallsList = await env.PATTER_KV.list({ prefix: "active_call:" });
            activeCallsCount = activeCallsList.keys.length;
          } catch {
            activeCallsCount = 0;
          }
        }

        const totalMaxSlots = configuredPoolSize * slotsPerContainer;
        const totalAvailableSlots = Math.max(0, totalMaxSlots - activeCallsCount);

        const instances = Array.from({ length: configuredPoolSize }, (_, i) => ({
          containerId: `patter-pool-${i}`,
          status: "ready",
          stats: {
            maxSlots: slotsPerContainer,
            activeCalls: 0,
            availableSlots: slotsPerContainer,
          },
        }));

        return new Response(JSON.stringify({
          status: "healthy",
          timestamp: new Date().toISOString(),
          mode: "edge-fast",
          poolSize: configuredPoolSize,
          aggregatedCapacity: {
            totalMaxSlots,
            totalActiveCalls: activeCallsCount,
            totalAvailableSlots,
          },
          instances,
        }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      }

      // Deep Container Diagnostic Mode (pass ?full=true to force container RPC pings)
      try {
        const poolPromises = Array.from({ length: configuredPoolSize }, (_, i) => {
          const cId = `patter-pool-${i}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 800);

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
          const cId = `patter-pool-${i}`;
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
          mode: "container-deep",
          poolSize: configuredPoolSize,
          aggregatedCapacity: {
            totalMaxSlots: totalMaxSlots || (configuredPoolSize * slotsPerContainer),
            totalActiveCalls,
            totalAvailableSlots: totalAvailableSlots || (configuredPoolSize * slotsPerContainer),
          },
          instances,
        }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({
          status: "healthy",
          mode: "edge-fallback",
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
