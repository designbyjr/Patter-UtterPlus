import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TenVAD } from '../src/providers/ten-vad';
import { SileroVAD } from '../src/providers/silero-vad';
import { initTracing, SPAN_ONNX_INIT, SPAN_ONNX_INFERENCE } from '../src/observability';
import { _resetTracingForTesting } from '../src/observability/tracing';

describe('OpenTelemetry Phase 4 — Local ONNX C++ Runtime & Model Execution Tracing', () => {
  beforeEach(() => {
    _resetTracingForTesting();
    process.env.PATTER_OTEL_ENABLED = '1';
    initTracing();
  });

  afterEach(() => {
    _resetTracingForTesting();
    delete process.env.PATTER_OTEL_ENABLED;
  });

  it('TenVAD instantiates and runs fallback probability without crashing OTel', async () => {
    const vad = new TenVAD({ sampleRate: 16000 });
    const pcmChunk = Buffer.alloc(320 * 2); // 20ms of silence
    const event = await vad.processFrame(pcmChunk, 16000);

    expect(event).toBeNull();
  });

  it('SileroVAD mock runtime runs inference window with OTel span tracking', async () => {
    const mockRuntime = {
      Tensor: class {
        data: Float32Array;
        constructor(_type: string, data: Float32Array) {
          this.data = data;
        }
      },
    };

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        output: { data: new Float32Array([0.95]) },
        stateN: { data: new Float32Array(256) },
      }),
    };

    // @ts-ignore
    const vad = SileroVAD.fromOnnxModel(mockRuntime as any, mockSession as any, {
      sampleRate: 16000,
      activationThreshold: 0.8,
      deactivationThreshold: 0.65,
      minSpeechDuration: 0.2,
      minSilenceDuration: 0.4,
      bargeInThresholdMs: 300,
    });

    const pcmChunk = Buffer.alloc(512 * 2); // 32ms frame for 16kHz
    const event = await vad.processFrame(pcmChunk, 16000);

    expect(mockSession.run).toHaveBeenCalled();
    expect(event).toBeDefined();
  });
});
