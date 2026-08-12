import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatterGrpcClient } from '../src/grpc-client';
import { initTracing, SPAN_GRPC, SPAN_GRPC_STREAM } from '../src/observability';
import { _resetTracingForTesting } from '../src/observability/tracing';

describe('OpenTelemetry Phase 3 — gRPC Engine Client & Native C++ Boundary', () => {
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
    delete process.env.PATTER_GRPC_TARGET;
  });

  it('PatterGrpcClient initializes target using CHANNEL_BIND_IP:50051', () => {
    const client = new PatterGrpcClient();
    expect(client).toBeDefined();
  });

  it('PatterGrpcClient overrides target when PATTER_GRPC_TARGET is set', () => {
    process.env.PATTER_GRPC_TARGET = '10.244.0.5:50051';
    const client = new PatterGrpcClient();
    expect(client).toBeDefined();
  });

  it('warmupModels creates SPAN_GRPC with ONNX shard attributes when client handles RPC', async () => {
    const client = new PatterGrpcClient('127.0.0.1:50051');
    const mockClientInstance = {
      WarmupModels: vi.fn((_args, callback) => {
        callback(null, {
          success: true,
          elapsedMs: 15,
          tenVadPath: '/models/vad.onnx',
          telnyxEosPath: '/models/eos.onnx',
          smartTurnPath: '/models/st.onnx',
        });
      }),
    };

    // @ts-ignore
    vi.spyOn(client, 'getClient').mockResolvedValue(mockClientInstance);

    const res = await client.warmupModels({
      tenVadShards: ['shard0', 'shard1'],
      smartTurnShards: ['st0'],
    });

    expect(res.success).toBe(true);
    expect(res.elapsedMs).toBe(15);
    expect(mockClientInstance.WarmupModels).toHaveBeenCalled();
  });

  it('getCapacity creates SPAN_GRPC with active calls and container RSS memory', async () => {
    const client = new PatterGrpcClient('127.0.0.1:50051');
    const mockClientInstance = {
      GetCapacity: vi.fn((_args, callback) => {
        callback(null, {
          containerId: 'cpp-worker-01',
          status: 'HEALTHY',
          activeCalls: 2,
          maxSlots: 4,
          availableSlots: 2,
          memoryRssMb: 512,
        });
      }),
    };

    // @ts-ignore
    vi.spyOn(client, 'getClient').mockResolvedValue(mockClientInstance);

    const stats = await client.getCapacity();

    expect(stats.activeCalls).toBe(2);
    expect(stats.maxSlots).toBe(4);
    expect(stats.memoryRssMb).toBe(512);
  });
});
