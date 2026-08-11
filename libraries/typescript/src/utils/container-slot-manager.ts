/**
 * ContainerSlotManager — in-process WebSocket call slot gatekeeper for Cloudflare Container deployments.
 *
 * Tracks active Telnyx WebSocket sessions by call_session_id, enforces MAX_CONTAINER_CALL_SLOTS,
 * and exposes a /capacity + /health HTTP endpoint polled by the Cloudflare Durable Object
 * edge router for routing decisions.
 *
 * Design rules:
 *   1. acquire(id) is idempotent — re-acquiring an already-active id returns true.
 *   2. release(id) is a no-op if the id was never acquired.
 *   3. High-watermark (default 80 %) fires onHighWatermark() ONCE per surge, resetting
 *      when the next release() brings active count below the watermark.
 *   4. The HTTP server on port 8080 is optional (pass httpPort: 0 to disable).
 *
 * Usage:
 *   import { containerSlotManager } from 'getpatter';
 *   const ok = containerSlotManager.acquire(callSessionId);
 *   if (!ok) ws.terminate(); // let Telnyx re-route to another container
 *   // ... handle call ...
 *   containerSlotManager.release(callSessionId);
 */

import * as http from 'node:http';
import * as os from 'node:os';
import express from 'express';
import { WebSocketServer, WebSocket as WSWebSocket } from 'ws';
import { getLogger } from '../logger';

export interface ContainerSlotManagerOptions {
  /**
   * Hard cap on simultaneous call slots.
   * Default: MAX_CONTAINER_CALL_SLOTS env var, or 15 if unset.
   */
  readonly maxSlots?: number;
  /**
   * Ratio [0–1] above which onHighWatermark fires.
   * Default 0.80 (fires when activeCalls / maxSlots >= 0.80).
   */
  readonly highWatermarkRatio?: number;
  /**
   * Port for the /capacity and /health HTTP endpoints.
   * Default: CAPACITY_HTTP_PORT env var, or 8080.
   * Set to 0 to disable the HTTP server entirely.
   */
  readonly httpPort?: number;
  /**
   * Callback fired once when active call count crosses the high-watermark threshold.
   * Use this to asynchronously request a new container instance from the Durable Object
   * capacity registry before the hard cap is reached.
   */
  readonly onHighWatermark?: (activeCalls: number, maxSlots: number) => void;
  /**
   * Cooldown period in milliseconds after active call count drops to 0.
   * Allows last-minute background tasks, tool executions, and API polling to complete.
   * Default: CONTAINER_COOLDOWN_MS env var, or 120,000 ms (2 minutes).
   */
  readonly cooldownMs?: number;
  /**
   * Optional callback fired when the 2-minute cooldown period completes.
   */
  readonly onCooldownComplete?: () => void;
  /**
   * Identifier included in /capacity JSON responses.
   * Default: CONTAINER_ID env var, or os.hostname().
   */
  readonly containerId?: string;
  /**
   * Optional callback to delegate incoming Telnyx WebSocket streams directly to Patter StreamHandler.
   */
  readonly onConnection?: (ws: WSWebSocket, callSessionId: string) => void;
  /**
   * On-Demand Dynamic Push Callback for Cloudflare Load Balancer origin updates.
   * Fired immediately (< 5ms) when active call slot allocation changes.
   */
  readonly onCapacityChanged?: (activeCalls: number, maxSlots: number, isSaturated: boolean) => void;
}

export interface CapacityStats {
  readonly containerId: string;
  readonly status: 'HEALTHY' | 'AT_CAPACITY' | 'DRAINING_COOLDOWN';
  readonly activeCalls: number;
  readonly maxSlots: number;
  readonly availableSlots: number;
  readonly memoryRssMb: number;
  readonly cpuUtilizationPct: number;
  readonly uptimeSeconds: number;
  readonly isCoolingDown?: boolean;
}

export class ContainerSlotManager {
  private readonly activeSessions = new Map<string, true>();
  readonly maxSlots: number;
  private readonly highWatermarkRatio: number;
  readonly containerId: string;
  private readonly onHighWatermark?: (active: number, max: number) => void;
  private readonly cooldownMs: number;
  private readonly onCooldownComplete?: () => void;
  private readonly onConnection?: (ws: WSWebSocket, callSessionId: string) => void;
  private readonly onCapacityChanged?: (active: number, max: number, isSaturated: boolean) => void;
  private highWatermarkFired = false;
  private isCoolingDownState = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private httpServer: http.Server | null = null;
  private readonly startTime = Date.now();
  private cpuPercent = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime  = Date.now();
  private cpuSampleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ContainerSlotManagerOptions = {}) {
    this.maxSlots = opts.maxSlots ?? parseInt(process.env['MAX_CONTAINER_CALL_SLOTS'] ?? '15', 10);
    this.highWatermarkRatio = opts.highWatermarkRatio ?? 0.80;
    this.cooldownMs = opts.cooldownMs ?? parseInt(process.env['CONTAINER_COOLDOWN_MS'] ?? '120000', 10);
    this.onCooldownComplete = opts.onCooldownComplete;
    this.onConnection = opts.onConnection;
    this.onCapacityChanged = opts.onCapacityChanged;
    this.containerId =
      opts.containerId ??
      process.env['CONTAINER_ID'] ??
      os.hostname();
    this.onHighWatermark = opts.onHighWatermark;

    const httpPort = opts.httpPort ?? parseInt(process.env['CAPACITY_HTTP_PORT'] ?? '8080', 10);
    if (httpPort > 0) {
      this.startHttpServer(httpPort);
    }

    // Sample CPU every 5 s; unref so it never blocks process exit
    this.cpuSampleTimer = setInterval(() => this.sampleCpu(), 5_000);
    this.cpuSampleTimer.unref?.();
  }

  /**
   * Attempt to acquire a call slot for the given call_session_id.
   * Cancels active cooldown if the container receives a call.
   */
  acquire(callSessionId: string): boolean {
    if (this.activeSessions.has(callSessionId)) return true;
    if (this.activeSessions.size >= this.maxSlots) {
      getLogger().warn(
        `[PATTER] ContainerSlotManager: at capacity (${this.activeSessions.size}/${this.maxSlots}), ` +
          `rejecting ${callSessionId}`
      );
      return false;
    }
    // Cancel cooldown if active
    this.cancelCooldown();

    this.activeSessions.set(callSessionId, true);
    this.maybeFireHighWatermark();
    this.onCapacityChanged?.(this.activeSessions.size, this.maxSlots, this.activeSessions.size >= this.maxSlots);
    getLogger().debug(
      `[PATTER] ContainerSlotManager: +slot ${callSessionId} ` +
        `(${this.activeSessions.size}/${this.maxSlots})`
    );
    return true;
  }

  /**
   * Release the slot held by callSessionId. Safe to call even if id was never acquired.
   * If active session count drops to 0, starts 2-minute cooldown timer to allow outstanding
   * LLM background tasks and API polling to complete.
   */
  release(callSessionId: string): void {
    if (!this.activeSessions.delete(callSessionId)) return;
    // Reset high-watermark latch once load drops below threshold
    if (this.activeSessions.size / this.maxSlots < this.highWatermarkRatio) {
      this.highWatermarkFired = false;
    }
    this.onCapacityChanged?.(this.activeSessions.size, this.maxSlots, this.activeSessions.size >= this.maxSlots);
    getLogger().debug(
      `[PATTER] ContainerSlotManager: -slot ${callSessionId} ` +
        `(${this.activeSessions.size}/${this.maxSlots})`
    );

    // If 0 active calls, start 2-minute cooldown timer
    if (this.activeSessions.size === 0 && this.cooldownMs > 0) {
      this.startCooldown();
    }
  }

  get activeCount(): number {
    return this.activeSessions.size;
  }

  get availableSlots(): number {
    return Math.max(0, this.maxSlots - this.activeSessions.size);
  }

  get isAtCapacity(): boolean {
    return this.activeSessions.size >= this.maxSlots;
  }

  get isCoolingDown(): boolean {
    return this.isCoolingDownState;
  }

  getCapacityStats(): CapacityStats {
    const rss = process.memoryUsage().rss;
    let status: 'HEALTHY' | 'AT_CAPACITY' | 'DRAINING_COOLDOWN' = 'HEALTHY';
    if (this.isAtCapacity) {
      status = 'AT_CAPACITY';
    } else if (this.isCoolingDownState) {
      status = 'DRAINING_COOLDOWN';
    }

    return {
      containerId:      this.containerId,
      status,
      activeCalls:      this.activeSessions.size,
      maxSlots:         this.maxSlots,
      availableSlots:   this.availableSlots,
      memoryRssMb:      Math.round(rss / 1024 / 1024),
      cpuUtilizationPct: Math.round(this.cpuPercent * 10) / 10,
      uptimeSeconds:    Math.round((Date.now() - this.startTime) / 1000),
      isCoolingDown:    this.isCoolingDownState,
    };
  }

  private startCooldown(): void {
    this.cancelCooldown();
    this.isCoolingDownState = true;
    getLogger().info(
      `[PATTER] ContainerSlotManager: 0 active calls — entering ${this.cooldownMs / 1000}s cooldown ` +
        `for background task/API polling completion`
    );
    this.cooldownTimer = setTimeout(() => {
      this.isCoolingDownState = false;
      this.cooldownTimer = null;
      getLogger().info(`[PATTER] ContainerSlotManager: cooldown period completed`);
      this.onCooldownComplete?.();
    }, this.cooldownMs);
    this.cooldownTimer.unref?.();
  }

  private cancelCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.isCoolingDownState) {
      this.isCoolingDownState = false;
      getLogger().info(`[PATTER] ContainerSlotManager: cooldown interrupted by new incoming call`);
    }
  }

  /** Gracefully shut down the capacity HTTP server and CPU sampling timer. */
  async close(): Promise<void> {
    this.cancelCooldown();
    if (this.cpuSampleTimer) {
      clearInterval(this.cpuSampleTimer);
      this.cpuSampleTimer = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  private maybeFireHighWatermark(): void {
    if (this.highWatermarkFired) return;
    const ratio = this.activeSessions.size / this.maxSlots;
    if (ratio >= this.highWatermarkRatio) {
      this.highWatermarkFired = true;
      getLogger().info(
        `[PATTER] ContainerSlotManager: high-watermark reached ` +
          `(${this.activeSessions.size}/${this.maxSlots}, ` +
          `${Math.round(ratio * 100)}%) — signalling pre-warm`
      );
      this.onHighWatermark?.(this.activeSessions.size, this.maxSlots);
    }
  }

  private sampleCpu(): void {
    const now   = Date.now();
    const usage = process.cpuUsage(this.lastCpuUsage);
    const elapsed = now - this.lastCpuTime;
    if (elapsed > 0) {
      this.cpuPercent = ((usage.user + usage.system) / 1000 / elapsed) * 100;
    }
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime  = now;
  }

  private startHttpServer(port: number): void {
    const app = express();
    app.disable('x-powered-by');

    // GET /health — container health status
    app.get('/health', (_req, res) => {
      const stats = this.getCapacityStats();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        capacity: stats,
      });
    });

    // GET /capacity — slot capacity stats for load balancing
    app.get('/capacity', (_req, res) => {
      res.json(this.getCapacityStats());
    });

    // GET /status — runtime statistics and uptime
    app.get('/status', (_req, res) => {
      res.json({
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        capacity: this.getCapacityStats(),
      });
    });

    // Clean JSON 404 handler for unmatched routes
    app.use((req, res) => {
      res.status(404).json({ error: 'Route not found', path: req.path });
    });

    this.httpServer = http.createServer(app);

    const wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const host = request.headers.host || 'localhost';
      const url = new URL(request.url ?? '', `http://${host}`);
      if (url.pathname === '/media') {
        const callSessionId = url.searchParams.get('call_session_id') || 
                             (request.headers['x-call-id'] as string) || 
                             `session-${Math.random().toString(36).substring(7)}`;

        if (!this.acquire(callSessionId)) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nContainer at capacity\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          (ws as WSWebSocket & { callSessionId?: string }).callSessionId = callSessionId;
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws: WSWebSocket & { callSessionId?: string }) => {
      const sessionId = ws.callSessionId || `session-${Math.random().toString(36).substring(7)}`;
      getLogger().info(`[PATTER] Container media stream connected (sessionId=${sessionId})`);

      if (this.onConnection) {
        // Delegate WebSocket connection directly to Patter StreamHandler
        this.onConnection(ws, sessionId);
      } else {
        // Default stub echo handler
        ws.on('message', (data) => {
          ws.send(JSON.stringify({ event: 'media_frame_ack', size: data.toString().length }));
        });
      }

      ws.on('close', () => {
        if (ws.callSessionId) {
          getLogger().info(`[PATTER] Container media stream closed (sessionId=${ws.callSessionId})`);
          this.release(ws.callSessionId);
        }
      });
    });

    this.httpServer.listen(port, '0.0.0.0', () => {
      getLogger().info(
        `[PATTER] ContainerSlotManager: capacity endpoint listening on 0.0.0.0:${port}`
      );
    });

    this.httpServer.on('error', (err) => {
      getLogger().warn(
        `[PATTER] ContainerSlotManager: HTTP server error: ${err.message}`
      );
    });
  }
}

/**
 * Process-level singleton slot manager.
 * Auto-initialises on first import; reads MAX_CONTAINER_CALL_SLOTS from env.
 */
export const containerSlotManager = new ContainerSlotManager();
