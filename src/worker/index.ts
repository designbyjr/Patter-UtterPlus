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
    if (this.env.PATTER_KV) {
      try {
        const containerId = this.ctx.id.toString();
        const accountId = "27e89563673d4bcd83625e2e12948bd4";
        const hostname = `container-${containerId}.${accountId}.internal`;
        await this.env.PATTER_KV.put(`container:${containerId}`, JSON.stringify({
          containerId,
          hostname,
          ports: [8080, 8081, 8082, 8083],
          status: "ready",
          startedAt: new Date().toISOString(),
        }));
      } catch (err) {
        console.error("[Patter] Failed to register container in PATTER_KV:", err);
      }
    }
  }

  override async onStop() {
    console.log("[Patter] C++ ONNX Inference Container sleeping (scale-to-zero)...");
    if (this.env.PATTER_KV) {
      try {
        const containerId = this.ctx.id.toString();
        await this.env.PATTER_KV.delete(`container:${containerId}`);
      } catch (err) {
        console.error("[Patter] Failed to prune container from PATTER_KV:", err);
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, 8080);
  }
}


/**
 * Cloudflare Worker Router entry point.
 * Provides Edge-Level Load Balancing & Slot Capacity Gating across N container DO instances.
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

    // 3. Fast Edge Capacity Check (/capacity, /status)
    if (url.pathname === "/capacity" || url.pathname === "/status") {
      const isDeepCheck = url.searchParams.get("full") === "true";

      if (!isDeepCheck) {
        let activeCallsCount = 0;

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

      // Deep Container Diagnostic Mode (?full=true)
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

    // 4. Edge-Level Smart Load-Balancing & Capacity Gating (/media)
    const callSessionId = url.searchParams.get("call_session_id") || url.searchParams.get("CallSid") || "";

    // Track container slot allocations at the Edge
    const containerSlotCounts = new Map<number, number>();
    for (let i = 0; i < configuredPoolSize; i++) {
      containerSlotCounts.set(i, 0);
    }

    // If Workers KV is active, index live session counts per container
    if (env.PATTER_KV) {
      try {
        const activeSessions = await env.PATTER_KV.list({ prefix: "session_container:" });
        for (const key of activeSessions.keys) {
          const containerIdx = parseInt(key.name.split(":")[1] || "0", 10);
          const current = containerSlotCounts.get(containerIdx) || 0;
          containerSlotCounts.set(containerIdx, current + 1);
        }
      } catch {
        // Fallback to round-robin
      }
    }

    // Select container with available slots (activeCalls < maxSlots)
    let selectedPoolIndex = -1;

    if (callSessionId) {
      // Session hash pinning: try primary hashed container first
      let hash = 0;
      for (let i = 0; i < callSessionId.length; i++) {
        hash = (hash << 5) - hash + callSessionId.charCodeAt(i);
        hash |= 0;
      }
      const primaryIndex = Math.abs(hash) % configuredPoolSize;
      const primaryActive = containerSlotCounts.get(primaryIndex) || 0;

      if (primaryActive < slotsPerContainer) {
        selectedPoolIndex = primaryIndex;
      }
    }

    // If primary hashed container is full, pick the container with the MOST available slots
    if (selectedPoolIndex === -1) {
      let minActive = slotsPerContainer;
      for (let i = 0; i < configuredPoolSize; i++) {
        const active = containerSlotCounts.get(i) || 0;
        if (active < minActive) {
          minActive = active;
          selectedPoolIndex = i;
        }
      }
    }

    // Fallback round-robin if all report 0/unknown
    if (selectedPoolIndex === -1) {
      selectedPoolIndex = Math.floor(Math.random() * configuredPoolSize);
    }

    const targetContainerId = `patter-pool-${selectedPoolIndex}`;
    const targetContainer = getContainer(env.INFERENCE_CONTAINER, targetContainerId);

    // Record session assignment at Edge KV for instant load balancing
    if (env.PATTER_KV && callSessionId) {
      void env.PATTER_KV.put(`session_container:${selectedPoolIndex}:${callSessionId}`, "1", { expirationTtl: 3600 });
    }

    return targetContainer.fetch(request);
  },
};
