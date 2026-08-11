/**
 * container-boot-simulation.test.ts
 *
 * Full boot path simulation for Cloudflare Containers running Patter voice agents.
 * Verifies container boot sequence: ContainerSlotManager init, capacity server listening,
 * pre-warm model downloads, call slot acquisition/release, and high-watermark scaling triggers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { ContainerSlotManager } from '../src/utils/container-slot-manager';
import { warmContainerModels } from '../src/utils/container-model-warmup';

function httpGetJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

describe('Container Boot Path Simulation', () => {
  let slotManager: ContainerSlotManager;
  const PORT = 19080;

  beforeEach(() => {
    delete process.env['MAX_CONTAINER_CALL_SLOTS'];
    delete process.env['CONTAINER_ID'];
  });

  afterEach(async () => {
    if (slotManager) {
      await slotManager.close();
    }
  });

  it('simulates a complete cold-boot sequence: boot → warmup → http check → 4 calls → high-watermark pre-warm trigger → drain', async () => {
    const hwTriggered: { active: number; max: number }[] = [];

    // Step 1: Initialize Slot Manager on container boot for standard-4 (4 max slots)
    slotManager = new ContainerSlotManager({
      maxSlots: 4,
      highWatermarkRatio: 0.75, // 3 / 4 calls
      httpPort: PORT,
      containerId: 'cf-cont-sim-001',
      onHighWatermark: (active, max) => hwTriggered.push({ active, max }),
    });

    // Step 2: Container model warmup (skipped cleanly if no R2 creds)
    const warmupResult = await warmContainerModels();
    expect(warmupResult).toBeDefined();

    // Step 3: Durable Object Edge Router polls /capacity endpoint
    const stats = await httpGetJson(`http://127.0.0.1:${PORT}/capacity`);
    expect(stats['status']).toBe('HEALTHY');
    expect(stats['activeCalls']).toBe(0);
    expect(stats['availableSlots']).toBe(4);
    expect(stats['containerId']).toBe('cf-cont-sim-001');

    // Step 4: Route calls into the container
    expect(slotManager.acquire('call-sim-0')).toBe(true);
    expect(slotManager.acquire('call-sim-1')).toBe(true);
    expect(hwTriggered.length).toBe(0);

    // Step 5: 3rd call reaches 75% watermark (3 / 4) -> fires scaling trigger
    expect(slotManager.acquire('call-sim-2')).toBe(true);
    expect(hwTriggered.length).toBe(1);
    expect(hwTriggered[0]).toEqual({ active: 3, max: 4 });

    // Step 6: Acquire remaining slot up to hard capacity limit
    expect(slotManager.acquire('call-sim-3')).toBe(true);

    // Step 7: 5th call rejected
    expect(slotManager.acquire('call-sim-4')).toBe(false);

    // Step 8: Verify AT_CAPACITY status via HTTP endpoint
    const statsFull = await httpGetJson(`http://127.0.0.1:${PORT}/capacity`);
    expect(statsFull['status']).toBe('AT_CAPACITY');
    expect(statsFull['availableSlots']).toBe(0);

    // Step 9: Calls finish and release slots
    for (let i = 0; i < 4; i++) {
      slotManager.release(`call-sim-${i}`);
    }

    const statsEmpty = await httpGetJson(`http://127.0.0.1:${PORT}/capacity`);
    expect(statsEmpty['status']).toBe('DRAINING_COOLDOWN');
    expect(statsEmpty['activeCalls']).toBe(0);
    expect(statsEmpty['availableSlots']).toBe(4);
  });
});
