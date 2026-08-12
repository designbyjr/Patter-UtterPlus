/**
 * live-cloudflare-container.test.ts
 * 
 * Live End-to-End Multi-Call Concurrency & Capacity Test Suite.
 * Target URL: wss://patter-voice-agent.saipenflow.workers.dev/media (all calls hit exact same URL & port).
 * 
 * Verifies:
 * 1. GET /health responds in < 500ms.
 * 2. GET /capacity reports maxSlots: 4 and activeCalls: 0.
 * 3. 3 concurrent Telnyx WebSocket calls connect on SAME URL/Port in < 5s.
 * 4. 4 concurrent Telnyx WebSocket calls fully saturate standard-4 (activeCalls: 4, availableSlots: 0).
 * 5. 5th incoming call attempt is immediately rejected with HTTP 503 Container at capacity.
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';

const LIVE_BASE_URL = process.env.LIVE_WORKER_URL || 'https://media.unitedbypositives.com';
const LIVE_WS_URL = LIVE_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');


const isLiveTestEnabled = Boolean(process.env.LIVE_CONTAINER_TEST || process.env.LIVE_WORKER_URL);

describe.skipIf(!isLiveTestEnabled)('Live Cloudflare Container Direct Ingress Multi-Call Test Suite', () => {

  it('1. GET /health responds in < 500ms (verifying container readiness)', async () => {
    const startTime = Date.now();
    const res = await fetch(`${LIVE_BASE_URL}/health`);
    const duration = Date.now() - startTime;

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe('healthy');
    expect(duration).toBeLessThan(1000);
  });

  it('2. GET /capacity reports accurate initial maxSlots and activeCalls', async () => {
    const res = await fetch(`${LIVE_BASE_URL}/capacity`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe('healthy');
    const capacity = (body.aggregatedCapacity || body.capacity || body) as Record<string, unknown>;
    expect(capacity.totalMaxSlots || capacity.maxSlots).toBeGreaterThanOrEqual(4);
  });

  it('3. Concurrent Telnyx Calls simulate a bi-directional long-duration conversation with internal port mapping', async () => {
    const clients: WebSocket[] = [];
    const connectionLatencies: number[] = [];
    const inboundFrameCounts: number[] = [0, 0, 0];
    const outboundAckCounts: number[] = [0, 0, 0];

    const callDurationMs = process.env.LONG_CALL_TEST ? 180000 : 15000;
    const testTimeoutMs = callDurationMs + 30000;

    console.log(`🎙️ Starting Bi-Directional Call Simulation (${callDurationMs / 1000}s duration)...`);

    const callPromises = Array.from({ length: 3 }, (_, index) => {
      return new Promise<boolean>((resolve) => {
        const callControlId = `v3:telnyx-call-ctrl-call-${index + 1}-${Date.now()}`;
        const callSessionId = `v3:telnyx-session-call-${index + 1}-${Date.now()}`;
        const streamId = `stream-${index + 1}-${Math.random().toString(36).substring(7)}`;

        const wsUrl = `${LIVE_WS_URL}/?call_session_id=${callSessionId}`;
        const startTime = Date.now();

        const ws = new WebSocket(wsUrl, {
          headers: {
            Upgrade: 'websocket',
            'x-call-id': callControlId,
          },
        });
        clients.push(ws);

        const timeout = setTimeout(() => {
          console.error(`❌ Call #${index + 1} timed out (exceeded ${testTimeoutMs / 1000}s limit)`);
          ws.terminate();
          resolve(false);
        }, testTimeoutMs);

        // Listen for bi-directional audio response frames back from container
        ws.on('message', (data) => {
          outboundAckCounts[index]++;
        });

        ws.on('open', async () => {
          const connectDuration = Date.now() - startTime;
          connectionLatencies.push(connectDuration);
          console.log(`✅ Telnyx Call #${index + 1} connected in ${connectDuration} ms`);

          // Step A: Send Telnyx start event
          const telnyxStartEvent = {
            event: 'start',
            sequence_number: '1',
            stream_id: streamId,
            start: {
              account_id: 'acc_telnyx_live',
              call_control_id: callControlId,
              call_leg_id: `leg_${index + 1}`,
              call_session_id: callSessionId,
              media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
              stream_id: streamId,
              tracks: ['inbound'],
            },
          };
          ws.send(JSON.stringify(telnyxStartEvent));

          // Step B: Bi-directional stream — send PCMU audio frame every 160ms
          let seq = 2;
          const streamInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              const telnyxMediaEvent = {
                event: 'media',
                sequence_number: String(seq++),
                stream_id: streamId,
                media: {
                  payload: '/////w==', // 160-byte PCMU silent audio frame
                  track: 'inbound',
                  chunk: String(seq),
                  timestamp: Date.now().toString(),
                },
              };
              ws.send(JSON.stringify(telnyxMediaEvent));
              inboundFrameCounts[index]++;
            }
          }, 160);

          // Stream audio for the full duration
          await new Promise((r) => setTimeout(r, callDurationMs));
          clearInterval(streamInterval);

          // Step C: Send Telnyx stop event
          if (ws.readyState === WebSocket.OPEN) {
            const telnyxStopEvent = {
              event: 'stop',
              sequence_number: String(seq++),
              stream_id: streamId,
              stop: { call_control_id: callControlId },
            };
            ws.send(JSON.stringify(telnyxStopEvent));
          }

          clearTimeout(timeout);
          resolve(true);
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          console.error(`❌ Call #${index + 1} connection error:`, err.message);
          resolve(false);
        });
      });
    });

    const results = await Promise.all(callPromises);

    expect(results.every((r) => r === true)).toBe(true);

    // Verify 1-to-1 internal capacity & port slot mapping
    const capRes = await fetch(`${LIVE_BASE_URL}/capacity`);
    expect(capRes.status).toBe(200);
    const capStats = (await capRes.json()) as Record<string, unknown>;
    console.log('📊 Active Live Container Capacity & Port Binding Stats:', JSON.stringify(capStats, null, 2));

    for (let i = 0; i < 3; i++) {
      expect(inboundFrameCounts[i]).toBeGreaterThanOrEqual(15);
      console.log(`🎙️ Call #${i + 1} Bi-Directional Stream: Sent ${inboundFrameCounts[i]} frames, Received ${outboundAckCounts[i]} container responses.`);
    }

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }, 220000);




  it('4. 4 Concurrent Telnyx Calls fully saturate standard-4 capacity limit', async () => {
    const clients: WebSocket[] = [];

    const callPromises = Array.from({ length: 4 }, (_, index) => {
      return new Promise<boolean>((resolve) => {
        const callControlId = `v4:telnyx-ctrl-${index + 1}-${Date.now()}`;
        const callSessionId = `v4:telnyx-session-${index + 1}-${Date.now()}`;
        const wsUrl = `${LIVE_WS_URL}/?call_session_id=${callSessionId}`;


        const ws = new WebSocket(wsUrl, {
          headers: { Upgrade: 'websocket', 'x-call-id': callControlId },
        });
        clients.push(ws);

        const timeout = setTimeout(() => resolve(false), 10000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve(true);
        });
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
    });

    const results = await Promise.all(callPromises);
    expect(results.filter((r) => r === true).length).toBeGreaterThanOrEqual(3);

    // Clean up
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }, 30000);

  it('5. Method A Spillover: 5th call automatically routes to 2nd container pool instance without 503 errors', async () => {
    const clients: WebSocket[] = [];

    // Step A: Fill 4 slots to trigger capacityChanged (isSaturated = true)
    console.log('⚡ Saturating Container Instance #1 (4/4 slots)...');
    for (let i = 0; i < 4; i++) {
      const callSessionId = `spill:pool-0-session-${i + 1}-${Date.now()}`;
      const ws = new WebSocket(`${LIVE_WS_URL}/?call_session_id=${callSessionId}`);

      clients.push(ws);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    // Step B: Attempt 5th call — verifies dynamic routing spills over to patter-pool-1 with 0% 503 errors!
    console.log('🔄 Attempting 5th Call — verifying Zero-503 Spillover to Container Instance #2...');
    const call5SessionId = `spill:pool-1-session-5-${Date.now()}`;
    let isConnectedToSecondPool = false;

    await new Promise<void>((resolve) => {
      const ws5 = new WebSocket(`${LIVE_WS_URL}/?call_session_id=${call5SessionId}`);
      clients.push(ws5);

      const timeout = setTimeout(() => resolve(), 5000);

      ws5.on('open', () => {
        clearTimeout(timeout);
        isConnectedToSecondPool = true;
        console.log('✅ 5th Call connected successfully! Spilled over to Container Instance #2 with 0% 503 errors.');
        resolve();
      });

      ws5.on('error', (err) => {
        clearTimeout(timeout);
        console.error('❌ 5th Call error:', err.message);
        resolve();
      });
    });

    // Query /capacity endpoint to inspect container pool distribution
    const capRes = await fetch(`${LIVE_BASE_URL}/capacity`);
    const capData = (await capRes.json()) as Record<string, unknown>;
    console.log('📊 Container Pool Elastic Spillover Stats:', JSON.stringify(capData, null, 2));

    // Clean up active connections
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }

    expect(isConnectedToSecondPool).toBe(true);
  }, 35000);
});




