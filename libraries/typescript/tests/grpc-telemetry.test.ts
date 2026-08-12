import { describe, it, expect } from 'vitest';
import { PatterGrpcClient } from '../src/grpc-client';
import { containerSlotManager } from '../src/utils/container-slot-manager';

describe('gRPC Telemetry & ContainerSlotManager Events', () => {
  it('1. PatterGrpcClient instantiates target correctly from environment', () => {
    process.env['CHANNEL_BIND_IP'] = '10.244.0.1';
    const client = new PatterGrpcClient();
    expect(client).toBeDefined();
  });

  it('2. ContainerSlotManager emits slotAcquired, slotReleased, and capacityChanged events', async () => {
    let acquiredFired = false;
    let releasedFired = false;
    let capacityChangedFired = false;

    const onAcquired = (data: any) => {
      if (data.callSessionId === 'test-session-events-1') acquiredFired = true;
    };
    const onReleased = (data: any) => {
      if (data.callSessionId === 'test-session-events-1') releasedFired = true;
    };
    const onCapChanged = () => {
      capacityChangedFired = true;
    };

    containerSlotManager.events.on('slotAcquired', onAcquired);
    containerSlotManager.events.on('slotReleased', onReleased);
    containerSlotManager.events.on('capacityChanged', onCapChanged);

    const ok = containerSlotManager.acquire('test-session-events-1');
    expect(ok).toBe(true);
    expect(acquiredFired).toBe(true);
    expect(capacityChangedFired).toBe(true);

    containerSlotManager.release('test-session-events-1');
    expect(releasedFired).toBe(true);

    containerSlotManager.events.off('slotAcquired', onAcquired);
    containerSlotManager.events.off('slotReleased', onReleased);
    containerSlotManager.events.off('capacityChanged', onCapChanged);
  });
});
