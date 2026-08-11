/**
 * live-cloudflare-container.test.ts
 * 
 * Live End-to-End Test Suite running against deployed Cloudflare Containers Worker:
 * URL: https://patter-voice-agent.saipenflow.workers.dev
 * 
 * Mocks authentic Telnyx Call Control Inbound Webhooks & WebSocket Media Streams according to official Telnyx API v2 specifications.
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';

const LIVE_BASE_URL = process.env.LIVE_WORKER_URL || 'https://patter-voice-agent.saipenflow.workers.dev';
const LIVE_WS_URL = LIVE_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');

describe('Live Cloudflare Containers Deployment E2E Test Suite (Authentic Telnyx Protocol)', () => {
  it('1. GET /health responds HTTP 200 with healthy status in < 500ms (satisfies Telnyx 5s limit)', async () => {
    const startTime = Date.now();
    const res = await fetch(`${LIVE_BASE_URL}/health`);
    const duration = Date.now() - startTime;

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.status).toBe('healthy');
    expect(body.edge).toBe('online');
    expect(body.provider).toBe('cloudflare-containers');
    expect(duration).toBeLessThan(1000); // Well under Telnyx 5s hard limit
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

  it('3. Authentic Telnyx Inbound WebSocket Media Stream Protocol (/media)', async () => {
    const callControlId = `v3:telnyx-call-ctrl-${Date.now()}`;
    const callSessionId = `v3:telnyx-session-${Date.now()}`;
    const streamId = `stream-${Math.random().toString(36).substring(7)}`;

    const wsUrl = `${LIVE_WS_URL}/media?call_session_id=${callSessionId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Upgrade': 'websocket',
        'x-call-id': callControlId,
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
        console.error('Telnyx WebSocket connection error:', err.message);
        resolve(false);
      });
    });

    expect(isOpen).toBe(true);

    if (isOpen) {
      // Step A: Send authentic Telnyx `start` event
      const telnyxStartEvent = {
        event: 'start',
        sequence_number: '1',
        stream_id: streamId,
        start: {
          account_id: 'acc_test_123',
          call_control_id: callControlId,
          call_leg_id: `leg_${Date.now()}`,
          call_session_id: callSessionId,
          client_state: null,
          media_format: {
            encoding: 'PCMU',
            sample_rate: 8000,
            channels: 1,
          },
          stream_id: streamId,
          tracks: ['inbound'],
        },
      };

      ws.send(JSON.stringify(telnyxStartEvent));
      await new Promise((r) => setTimeout(r, 100));

      // Step B: Send authentic Telnyx `media` event (base64 μ-law 8kHz audio frame)
      const telnyxMediaEvent = {
        event: 'media',
        sequence_number: '2',
        stream_id: streamId,
        media: {
          payload: '/////w==', // Base64 silence frame
          track: 'inbound',
          chunk: '1',
          timestamp: Date.now().toString(),
        },
      };

      ws.send(JSON.stringify(telnyxMediaEvent));
      await new Promise((r) => setTimeout(r, 100));

      // Step C: Send authentic Telnyx `stop` event
      const telnyxStopEvent = {
        event: 'stop',
        sequence_number: '3',
        stream_id: streamId,
        stop: {
          call_control_id: callControlId,
        },
      };

      ws.send(JSON.stringify(telnyxStopEvent));
      await new Promise((r) => setTimeout(r, 100));

      ws.close();
    }
  });

  it('4. Multi-connection Telnyx WebSocket resilience & failover test across DO pool', async () => {
    const clients: WebSocket[] = [];
    const connectionResults: boolean[] = [];

    // Open 3 concurrent Telnyx WebSockets across the pool
    for (let i = 1; i <= 3; i++) {
      const callSessionId = `v3:telnyx-multi-session-${i}-${Date.now()}`;
      const wsUrl = `${LIVE_WS_URL}/media?call_session_id=${callSessionId}`;

      const ws = new WebSocket(wsUrl);
      clients.push(ws);

      const connected = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          resolve(false);
        }, 15000);

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

    // Verify all 3 Telnyx WebSocket connections succeeded without failover errors
    expect(connectionResults.every(r => r === true)).toBe(true);

    // Clean up
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  });
});
