import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContainerSlotManager } from '../src/utils/container-slot-manager';
import { initTracing, SPAN_SLOT_ACQUIRE, SPAN_SLOT_RELEASE, SPAN_CLOUDFLARE_PUSH } from '../src/observability';
import { _resetTracingForTesting } from '../src/observability/tracing';

describe('OpenTelemetry Phase 2 — Container Slot Manager & Cloudflare Saturation', () => {
  beforeEach(() => {
    _resetTracingForTesting();
    process.env.PATTER_OTEL_ENABLED = '1';
    process.env.CHANNEL_BIND_IP = '10.244.0.1';
    initTracing();
  });

  afterEach(() => {
    _resetTracingForTesting();
    delete process.env.PATTER_OTEL_ENABLED;
    delete process.env.CHANNEL_BIND_IP;
  });

  it('acquire() reserves a slot and emits acquire span metadata', () => {
    const slotManager = new ContainerSlotManager({ maxSlots: 2, httpPort: 0 });
    const success = slotManager.acquire('session_call_001');

    expect(success).toBe(true);
    expect(slotManager.activeCount).toBe(1);
    expect(slotManager.getCapacityStats().availableSlots).toBe(1);
  });

  it('acquire() at capacity rejects and marks container as saturated', () => {
    const slotManager = new ContainerSlotManager({ maxSlots: 1, httpPort: 0 });
    expect(slotManager.acquire('call_1')).toBe(true);

    const rejected = slotManager.acquire('call_2');
    expect(rejected).toBe(false);
    expect(slotManager.activeCount).toBe(1);
    expect(slotManager.getCapacityStats().availableSlots).toBe(0);
  });

  it('release() frees slot and resets active call count', () => {
    const slotManager = new ContainerSlotManager({ maxSlots: 2, httpPort: 0 });
    slotManager.acquire('call_1');
    expect(slotManager.activeCount).toBe(1);

    slotManager.release('call_1');
    expect(slotManager.activeCount).toBe(0);
    expect(slotManager.getCapacityStats().availableSlots).toBe(2);
  });

  it('Cloudflare capacity push invokes OTel span with origin weight 0 when saturated', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test_token';
    process.env.CLOUDFLARE_POOL_ID = 'test_pool_id';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({ success: true }),
    } as Response);

    const slotManager = new ContainerSlotManager({ maxSlots: 1, httpPort: 0 });
    slotManager.acquire('call_saturation_test'); // Fills 1/1 slot -> triggers capacity push (isSaturated = true)

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/load_balancers/pools/test_pool_id'),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"weight":0'),
      })
    );

    fetchSpy.mockRestore();
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_POOL_ID;
  });
});
