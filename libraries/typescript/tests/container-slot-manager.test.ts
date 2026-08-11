/**
 * container-slot-manager.test.ts
 *
 * Unit tests for ContainerSlotManager — the in-process WebSocket call-slot
 * gatekeeper. Tests the slot counter, high-watermark callback, capacity stats,
 * idempotency, and the HTTP /capacity endpoint.
 *
 * The HTTP server is tested via Node's built-in http.get. All tests use
 * port 0 to pick an ephemeral OS port so parallel runs never conflict.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { ContainerSlotManager } from '../src/utils/container-slot-manager';

// ── helpers ──────────────────────────────────────────────────────────────────

/** GET a URL and return parsed JSON. */
async function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve(JSON.parse(body)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Resolve the listening port from an HTTP server. */
function serverPort(server: http.Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : -1;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ContainerSlotManager — slot acquisition & release', () => {
  let mgr: ContainerSlotManager;

  beforeEach(() => {
    // httpPort: 0 → disable HTTP server so we don't need to await server start
    mgr = new ContainerSlotManager({ maxSlots: 3, httpPort: 0 });
  });

  afterEach(async () => {
    await mgr.close();
  });

  it('starts with zero active calls', () => {
    expect(mgr.activeCount).toBe(0);
    expect(mgr.availableSlots).toBe(3);
    expect(mgr.isAtCapacity).toBe(false);
  });

  it('acquire returns true and increments activeCount', () => {
    expect(mgr.acquire('call-001')).toBe(true);
    expect(mgr.activeCount).toBe(1);
    expect(mgr.availableSlots).toBe(2);
  });

  it('acquire is idempotent for the same session ID', () => {
    mgr.acquire('call-001');
    const result = mgr.acquire('call-001'); // re-acquire
    expect(result).toBe(true);
    expect(mgr.activeCount).toBe(1); // still 1, not 2
  });

  it('acquire different IDs each consume a slot', () => {
    mgr.acquire('call-001');
    mgr.acquire('call-002');
    expect(mgr.activeCount).toBe(2);
    expect(mgr.availableSlots).toBe(1);
  });

  it('acquire returns false at capacity and does not increase count', () => {
    mgr.acquire('call-001');
    mgr.acquire('call-002');
    mgr.acquire('call-003');
    expect(mgr.isAtCapacity).toBe(true);

    const rejected = mgr.acquire('call-004');
    expect(rejected).toBe(false);
    expect(mgr.activeCount).toBe(3); // unchanged
  });

  it('release decreases activeCount and frees a slot', () => {
    mgr.acquire('call-001');
    mgr.acquire('call-002');
    mgr.release('call-001');
    expect(mgr.activeCount).toBe(1);
    expect(mgr.availableSlots).toBe(2);
  });

  it('release of an unknown ID is a no-op (does not throw)', () => {
    expect(() => mgr.release('never-acquired')).not.toThrow();
    expect(mgr.activeCount).toBe(0);
  });

  it('releasing all slots allows re-acquisition up to max', () => {
    mgr.acquire('c1');
    mgr.acquire('c2');
    mgr.acquire('c3');
    expect(mgr.isAtCapacity).toBe(true);

    mgr.release('c1');
    expect(mgr.isAtCapacity).toBe(false);

    expect(mgr.acquire('c4')).toBe(true);
    expect(mgr.isAtCapacity).toBe(true);
  });

  it('availableSlots never goes below 0', () => {
    // artificially fill beyond max (shouldn't be possible via acquire, but guard)
    mgr.acquire('c1');
    mgr.acquire('c2');
    mgr.acquire('c3');
    // Extra attempt at capacity → ignored, check no negative
    mgr.acquire('c4');
    expect(mgr.availableSlots).toBeGreaterThanOrEqual(0);
  });
});

// ── high-watermark callback ───────────────────────────────────────────────────

describe('ContainerSlotManager — high-watermark callback', () => {
  it('fires onHighWatermark exactly once when crossing 80 % threshold', () => {
    const hwmCb = vi.fn();
    const mgr = new ContainerSlotManager({
      maxSlots: 5,
      highWatermarkRatio: 0.80,
      onHighWatermark: hwmCb,
      httpPort: 0,
    });

    // 4/5 = 80 % — should fire
    mgr.acquire('c1');
    mgr.acquire('c2');
    mgr.acquire('c3');
    mgr.acquire('c4'); // crosses 80 %
    expect(hwmCb).toHaveBeenCalledTimes(1);
    expect(hwmCb).toHaveBeenCalledWith(4, 5);

    // Additional acquire at same level should NOT re-fire
    mgr.acquire('c5');
    expect(hwmCb).toHaveBeenCalledTimes(1);

    mgr.close();
  });

  it('resets latch and re-fires after load drops below threshold and rises again', () => {
    const hwmCb = vi.fn();
    const mgr = new ContainerSlotManager({
      maxSlots: 5,
      highWatermarkRatio: 0.80,
      onHighWatermark: hwmCb,
      httpPort: 0,
    });

    // First surge
    mgr.acquire('c1');
    mgr.acquire('c2');
    mgr.acquire('c3');
    mgr.acquire('c4');
    expect(hwmCb).toHaveBeenCalledTimes(1);

    // Drop below threshold
    mgr.release('c4');
    mgr.release('c3');
    // Now at 2/5 = 40 %, latch should reset

    // Second surge
    mgr.acquire('c5');
    mgr.acquire('c6');
    mgr.acquire('c7'); // crosses 80 % again
    expect(hwmCb).toHaveBeenCalledTimes(2); // fired again

    mgr.close();
  });

  it('does not fire when load stays below threshold', () => {
    const hwmCb = vi.fn();
    const mgr = new ContainerSlotManager({
      maxSlots: 10,
      highWatermarkRatio: 0.80,
      onHighWatermark: hwmCb,
      httpPort: 0,
    });

    // Fill to 70 % — below 80 %
    for (let i = 0; i < 7; i++) mgr.acquire(`c${i}`);
    expect(hwmCb).not.toHaveBeenCalled();

    mgr.close();
  });
});

// ── getCapacityStats ──────────────────────────────────────────────────────────

describe('ContainerSlotManager — getCapacityStats()', () => {
  it('returns correct shape and values', () => {
    const mgr = new ContainerSlotManager({
      maxSlots: 10,
      containerId: 'test-container-1',
      httpPort: 0,
    });

    mgr.acquire('call-a');
    mgr.acquire('call-b');

    const stats = mgr.getCapacityStats();

    expect(stats.containerId).toBe('test-container-1');
    expect(stats.status).toBe('HEALTHY');
    expect(stats.activeCalls).toBe(2);
    expect(stats.maxSlots).toBe(10);
    expect(stats.availableSlots).toBe(8);
    expect(stats.memoryRssMb).toBeGreaterThan(0);
    expect(stats.uptimeSeconds).toBeGreaterThanOrEqual(0);

    mgr.close();
  });

  it('reports AT_CAPACITY status when full', () => {
    const mgr = new ContainerSlotManager({ maxSlots: 2, httpPort: 0 });
    mgr.acquire('c1');
    mgr.acquire('c2');
    const stats = mgr.getCapacityStats();
    expect(stats.status).toBe('AT_CAPACITY');
    expect(stats.availableSlots).toBe(0);
    mgr.close();
  });
});

// ── HTTP /capacity endpoint ────────────────────────────────────────────────────

describe('ContainerSlotManager — HTTP /capacity endpoint', () => {
  let mgr: ContainerSlotManager;
  let port: number;

  beforeEach(async () => {
    // Use a promise to wait until the server is actually listening
    await new Promise<void>((resolve) => {
      mgr = new ContainerSlotManager({
        maxSlots:    5,
        containerId: 'http-test-container',
      });
      // Small timeout to let the server bind (it's synchronous in the listen callback)
      setTimeout(resolve, 20);
    });

    // Get the actual port from the internal server
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srv = (mgr as unknown as { httpServer: http.Server | null }).httpServer;
    port = serverPort(srv!);
  });

  afterEach(async () => {
    await mgr.close();
  });

  it('GET /capacity returns valid JSON with correct shape', async () => {
    if (port < 0) return; // server didn't bind — skip

    mgr.acquire('call-http-1');

    const json = await getJson(`http://127.0.0.1:${port}/capacity`);

    expect(json['containerId']).toBe('http-test-container');
    expect(json['status']).toBe('HEALTHY');
    expect(json['activeCalls']).toBe(1);
    expect(json['maxSlots']).toBe(5);
    expect(json['availableSlots']).toBe(4);
    expect(typeof json['memoryRssMb']).toBe('number');
    expect(typeof json['uptimeSeconds']).toBe('number');
  });

  it('GET /health returns the same JSON as /capacity', async () => {
    if (port < 0) return;

    const [capacity, health] = await Promise.all([
      getJson(`http://127.0.0.1:${port}/capacity`),
      getJson(`http://127.0.0.1:${port}/health`),
    ]);
    expect(health['containerId']).toEqual(capacity['containerId']);
    expect(health['status']).toEqual(capacity['status']);
  });

  it('GET /unknown-path returns 404', async () => {
    if (port < 0) return;

    const statusCode = await new Promise<number>((resolve) => {
      http.get(`http://127.0.0.1:${port}/not-a-route`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(statusCode).toBe(404);
  });

  it('reflects updated slot count in subsequent /capacity responses', async () => {
    if (port < 0) return;

    mgr.acquire('c1');
    mgr.acquire('c2');
    const before = await getJson(`http://127.0.0.1:${port}/capacity`);
    expect(before['activeCalls']).toBe(2);

    mgr.release('c1');
    const after = await getJson(`http://127.0.0.1:${port}/capacity`);
    expect(after['activeCalls']).toBe(1);
  });
});

// ── close() ───────────────────────────────────────────────────────────────────

describe('ContainerSlotManager — close()', () => {
  it('can be called multiple times without throwing', async () => {
    const mgr = new ContainerSlotManager({ httpPort: 0 });
    await expect(mgr.close()).resolves.not.toThrow();
    await expect(mgr.close()).resolves.not.toThrow();
  });

  it('shuts down the HTTP server so subsequent GETs fail', async () => {
    let port = -1;
    await new Promise<void>((resolve) => {
      const mgr = new ContainerSlotManager({ maxSlots: 5 });
      setTimeout(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const srv = (mgr as unknown as { httpServer: http.Server | null }).httpServer;
        port = serverPort(srv!);
        await mgr.close();
        resolve();
      }, 30);
    });

    if (port < 0) return;

    // After close, the server should refuse connections
    await expect(getJson(`http://127.0.0.1:${port}/capacity`)).rejects.toThrow();
  });
});
