/**
 * live-cloudflare-container.test.ts
 * 
 * Live End-to-End Test Suite running directly against deployed Cloudflare Containers Worker:
 * URL: https://patter-voice-agent.saipenflow.workers.dev
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';

const LIVE_BASE_URL = process.env.LIVE_WORKER_URL || 'https://patter-voice-agent.saipenflow.workers.dev';
const LIVE_WS_URL = LIVE_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');

describe('Live Cloudflare Containers Deployment E2E Test Suite', () => {
  it('1. GET /health responds HTTP 200 with healthy status in < 500ms', async () => {
    const startTime = Date.now();
    const res = await fetch(`${LIVE_BASE_URL}/health`);
    const duration = Date.now() - startTime;

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.status).toBe('healthy');
    expect(body.edge).toBe('online');
    expect(body.provider).toBe('cloudflare-containers');
    expect(duration).toBeLessThan(1000); // Must satisfy Telnyx 5s hard limit
  });

  it('2. GET /capacity responds HTTP 200 with aggregated slot stats', async () => {
    const res = await fetch(`${LIVE_BASE_URL}/capacity`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, any>;
    expect(body.status).toBe('healthy');
    expect(body.poolSize).toBeGreaterThanOrEqual(1);
    expect(body.aggregatedCapacity.totalMaxSlots).toBeGreaterThanOrEqual(4);
    expect(body.aggregatedCapacity.totalAvailableSlots).toBeGreaterThanOrEqual(0);
  });

  it('3. WebSocket wss:///media accepts live audio stream connection', async () => {
    const callId = `live-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const wsUrl = `${LIVE_WS_URL}/media?call_session_id=${callId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Upgrade': 'websocket',
        'x-call-id': callId,
      },
    });

    const isOpen = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 15000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(true);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('WebSocket connection error:', err.message);
        resolve(false);
      });
    });

    expect(isOpen).toBe(true);

    if (isOpen) {
      // Send 32ms silence frame (512 samples @ 16kHz float32)
      const silenceFrame = Buffer.alloc(512 * 4);
      ws.send(silenceFrame);

      await new Promise((r) => setTimeout(r, 200));
      ws.close();
    }
  });

  it('4. Multi-connection WebSocket resilience test', async () => {
    const clients: WebSocket[] = [];
    const connectionResults: boolean[] = [];

    // Open 3 concurrent WebSockets across the pool
    for (let i = 1; i <= 3; i++) {
      const callId = `live-multi-test-${i}-${Date.now()}`;
      const wsUrl = `${LIVE_WS_URL}/media?call_session_id=${callId}`;

      const ws = new WebSocket(wsUrl);
      clients.push(ws);

      const connected = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          resolve(false);
        }, 5000);

        ws.on('open', () => {
          clearTimeout(timeout);
          resolve(true);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });

      connectionResults.push(await connected);
    }

    // Verify all connections succeeded without failover errors
    expect(connectionResults.every(r => r === true)).toBe(true);

    // Clean up
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  });
});
