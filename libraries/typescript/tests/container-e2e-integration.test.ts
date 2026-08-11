/**
 * container-e2e-integration.test.ts
 *
 * End-to-End Live Container Multi-Call Integration Test Suite.
 *
 * Tests:
 * 1. Multi-call concurrency on container slot manager (up to MAX_CONTAINER_CALL_SLOTS = 4 for standard-4).
 * 2. Real-time capacity monitoring (/capacity and /health HTTP responses).
 * 3. Capacity rejection on the 5th call when 4 slots are saturated (4 vCPU / ONNX model allocation).
 * 4. Slot recovery and status transition back to HEALTHY upon call disconnect.
 * 5. Full parallel WebSocket audio frame streaming simulation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { ContainerSlotManager } from '../src/utils/container-slot-manager';

/** GET JSON from HTTP URL helper */
async function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(JSON.parse(body)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('Cloudflare Container Multi-Call Integration Test Suite (standard-4 / 4 Slots)', () => {
  let slotManager: ContainerSlotManager;
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    // Standard-4 configuration: max 4 slots (1 vCPU per ONNX model execution pipeline)
    slotManager = new ContainerSlotManager({
      maxSlots: 4,
      containerId: 'container-std4-test-node',
      highWatermarkRatio: 0.75, // High watermark triggers at 3 calls (75%)
      httpPort: 0, // In-process test server
    });

    // Create an HTTP + WebSocket test server mimicking the container Crow C++ engine
    server = http.createServer((req, res) => {
      if (req.url === '/capacity' || req.url === '/health') {
        const stats = slotManager.getCapacityStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);
      if (url.pathname === '/media') {
        const callId = request.headers['x-call-id'] as string || `call-${Math.random().toString(36).substring(7)}`;

        if (!slotManager.acquire(callId)) {
          // 5th call rejected due to capacity limits
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nContainer at capacity');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          (ws as WebSocket & { callId: string }).callId = callId;
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws: WebSocket & { callId?: string }) => {
      ws.on('message', (data: WebSocket.RawData) => {
        // Echo back frame processed status
        ws.send(Buffer.from(JSON.stringify({ event: 'audio_frame_processed', bytes: data.toString().length })));
      });

      ws.on('close', () => {
        if (ws.callId) {
          slotManager.release(ws.callId);
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await slotManager.close();
  });

  it('1. Initial container state has 4 available slots and is HEALTHY', async () => {
    const stats = await fetchJson(`http://127.0.0.1:${port}/capacity`);
    expect(stats['status']).toBe('HEALTHY');
    expect(stats['maxSlots']).toBe(4);
    expect(stats['activeCalls']).toBe(0);
    expect(stats['availableSlots']).toBe(4);
  });

  it('2. Multi-call concurrency: supports 4 parallel active WebSocket calls on standard-4', async () => {
    const clients: WebSocket[] = [];

    // Connect 4 concurrent call streams
    for (let i = 1; i <= 4; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, {
        headers: { 'x-call-id': `concurrent-call-${i}` },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      clients.push(ws);
    }

    // Verify all 4 slots are occupied
    const stats = await fetchJson(`http://127.0.0.1:${port}/capacity`);
    expect(stats['activeCalls']).toBe(4);
    expect(stats['availableSlots']).toBe(0);
    expect(stats['status']).toBe('AT_CAPACITY');

    // Clean up
    for (const ws of clients) {
      ws.close();
    }
  });

  it('3. Saturated container rejects 5th concurrent call with HTTP 503 / capacity notice', async () => {
    const clients: WebSocket[] = [];

    // Fill all 4 slots
    for (let i = 1; i <= 4; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, {
        headers: { 'x-call-id': `fill-call-${i}` },
      });
      await new Promise<void>((resolve) => ws.on('open', resolve));
      clients.push(ws);
    }

    // Attempt 5th call — must be rejected
    const fifthWs = new WebSocket(`ws://127.0.0.1:${port}/media`, {
      headers: { 'x-call-id': 'overflow-call-5' },
    });

    const rejected = await new Promise<boolean>((resolve) => {
      fifthWs.on('error', () => resolve(true));
      fifthWs.on('unexpected-response', (req, res) => {
        resolve(res.statusCode === 503);
      });
      fifthWs.on('open', () => resolve(false));
    });

    expect(rejected).toBe(true);

    // Active calls count remains strictly at 4
    expect(slotManager.activeCount).toBe(4);

    for (const ws of clients) {
      ws.close();
    }
  });

  it('4. Slot recovery: releasing call disconnects returns status to HEALTHY and restores available slots', async () => {
    const clients: WebSocket[] = [];

    for (let i = 1; i <= 4; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, {
        headers: { 'x-call-id': `recover-call-${i}` },
      });
      await new Promise<void>((resolve) => ws.on('open', resolve));
      clients.push(ws);
    }

    expect(slotManager.isAtCapacity).toBe(true);

    // Close 2 calls
    clients[0].close();
    clients[1].close();

    // Small delay to allow WS close events to process
    await new Promise((r) => setTimeout(r, 50));

    const stats = await fetchJson(`http://127.0.0.1:${port}/capacity`);
    expect(stats['activeCalls']).toBe(2);
    expect(stats['availableSlots']).toBe(2);
    expect(stats['status']).toBe('HEALTHY');

    clients[2].close();
    clients[3].close();
  });

  it('5. Bi-directional PCM audio frame processing works across all 4 parallel call channels', async () => {
    const clients: WebSocket[] = [];
    const responses: string[] = [];

    for (let i = 1; i <= 4; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, {
        headers: { 'x-call-id': `audio-call-${i}` },
      });
      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.on('message', (msg) => responses.push(msg.toString()));
      clients.push(ws);
    }

    // Send 32ms float32 audio frame buffer across all 4 channels concurrently
    const pcm32msFrame = Buffer.alloc(512 * 4); // 512 samples @ float32
    for (const ws of clients) {
      ws.send(pcm32msFrame);
    }

    await new Promise((r) => setTimeout(r, 100));

    // Verify all 4 channels received frame responses
    expect(responses.length).toBe(4);
    for (const resp of responses) {
      expect(resp).toContain('audio_frame_processed');
    }

    for (const ws of clients) {
      ws.close();
    }
  });
});
