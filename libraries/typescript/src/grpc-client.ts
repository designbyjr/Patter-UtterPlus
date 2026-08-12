/**
 * Patter gRPC Engine Client — TypeScript wrapper for C++ Native Inference Engine.
 *
 * Connects via Unix Domain Socket (unix:///tmp/patter-engine.sock) or TCP (127.0.0.1:50051).
 * Eliminates FUSE volume mounting and replaces JavaScript ONNX execution with native C++ gRPC calls.
 *
 * Usage:
 *   import { PatterGrpcClient } from 'getpatter';
 *   const engine = new PatterGrpcClient();
 *   const stats = await engine.getCapacity();
 *   const warmup = await engine.warmupModels({ tenVadShards: ['s0', 's1'] });
 */

import * as path from 'node:path';
import { getLogger } from './logger';
import { startSpan, SPAN_GRPC, SPAN_GRPC_STREAM } from './observability';

export interface GrpcWarmupOptions {
  readonly tenVadShards?: readonly string[];
  readonly telnyxEosShards?: readonly string[];
  readonly smartTurnShards?: readonly string[];
  readonly workerEndpoint?: string;
}

export interface GrpcWarmupResult {
  readonly success: boolean;
  readonly elapsedMs: number;
  readonly tenVadPath: string;
  readonly telnyxEosPath: string;
  readonly smartTurnPath: string;
  readonly errorMessage?: string;
}

export interface GrpcCapacityStats {
  readonly containerId: string;
  readonly status: 'HEALTHY' | 'AT_CAPACITY' | 'DRAINING_COOLDOWN' | string;
  readonly activeCalls: number;
  readonly maxSlots: number;
  readonly availableSlots: number;
  readonly memoryRssMb: number;
  readonly cpuUtilizationPct: number;
  readonly uptimeSeconds: number;
  readonly isCoolingDown: boolean;
}

export interface GrpcInferenceEvent {
  readonly callSessionId: string;
  readonly vadScore: number;
  readonly eosScore: number;
  readonly isUserSpeaking: boolean;
  readonly isTurnComplete?: boolean;
  readonly blockNumber: number;
}


export interface GrpcTelemetryEvent {

  readonly callSessionId: string;
  readonly cppInferenceUs: number;
  readonly nodeRoundtripMs: number;
  readonly channelPort: number;
  readonly status: string;
}

export class PatterGrpcClient {
  private readonly target: string;
  private clientInstance: any = null;

  constructor(target?: string) {
    const bindIp = process.env['CHANNEL_BIND_IP'];
    const defaultTarget = bindIp ? `${bindIp}:50051` : 'unix:///tmp/patter-engine.sock';
    this.target = target ?? process.env['PATTER_GRPC_TARGET'] ?? defaultTarget;
  }

  private async getClient(): Promise<any> {
    if (this.clientInstance) return this.clientInstance;
    const initSpan = startSpan(SPAN_GRPC, {
      'patter.grpc.method': 'initClient',
      'patter.grpc.target': this.target,
      'patter.grpc.port': 50051,
      'patter.channel.bind_ip': process.env['CHANNEL_BIND_IP'] ?? '127.0.0.1',
    });
    try {
      // @ts-ignore
      const grpc = await import('@grpc/grpc-js');
      // @ts-ignore
      const protoLoader = await import('@grpc/proto-loader');

      const protoPath = path.resolve(__dirname, '../../../proto/patter_engine.proto');
      const packageDefinition = protoLoader.loadSync(protoPath, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
      const PatterService = protoDescriptor.patter.engine.PatterInferenceEngine;

      this.clientInstance = new PatterService(
        this.target,
        grpc.credentials.createInsecure()
      );
      initSpan.setAttribute('patter.grpc.connected', true);
      return this.clientInstance;
    } catch (err) {
      initSpan.recordException(err as Error);
      throw new Error(
        `PatterGrpcClient: failed to load @grpc/grpc-js or proto schema: ${(err as Error).message}`
      );
    } finally {
      try { initSpan.end(); } catch { /* swallow */ }
    }
  }

  /**
   * Pre-warm ONNX model shards into C++ engine memory / local disk via gRPC.
   */
  async warmupModels(opts: GrpcWarmupOptions = {}): Promise<GrpcWarmupResult> {
    const client = await this.getClient();
    const span = startSpan(SPAN_GRPC, {
      'patter.grpc.method': 'WarmupModels',
      'patter.grpc.target': this.target,
      'patter.grpc.port': 50051,
      'patter.channel.bind_ip': process.env['CHANNEL_BIND_IP'] ?? '127.0.0.1',
      'patter.onnx.ten_vad_shards': (opts.tenVadShards ?? []).length,
      'patter.onnx.smart_turn_shards': (opts.smartTurnShards ?? []).length,
    });
    return new Promise((resolve, reject) => {
      client.WarmupModels(
        {
          tenVadShards: opts.tenVadShards ?? [],
          telnyxEosShards: opts.telnyxEosShards ?? [],
          smartTurnShards: opts.smartTurnShards ?? [],
          workerEndpoint: opts.workerEndpoint ?? process.env['PATTER_R2_WORKER_URL'] ?? '',
        },
        (err: Error | null, response: any) => {
          if (err) {
            span.recordException(err);
            try { span.end(); } catch { /* swallow */ }
            return reject(err);
          }
          const elapsed = Number(response.elapsedMs ?? 0);
          span.setAttribute('patter.grpc.elapsed_ms', elapsed);
          span.setAttribute('patter.grpc.success', Boolean(response.success));
          try { span.end(); } catch { /* swallow */ }
          resolve({
            success: response.success,
            elapsedMs: elapsed,
            tenVadPath: response.tenVadPath ?? '',
            telnyxEosPath: response.telnyxEosPath ?? '',
            smartTurnPath: response.smartTurnPath ?? '',
            errorMessage: response.errorMessage,
          });
        }
      );
    });
  }

  /**
   * Poll capacity stats from the C++ gRPC engine.
   */
  async getCapacity(): Promise<GrpcCapacityStats> {
    const client = await this.getClient();
    const span = startSpan(SPAN_GRPC, {
      'patter.grpc.method': 'GetCapacity',
      'patter.grpc.target': this.target,
      'patter.grpc.port': 50051,
      'patter.channel.bind_ip': process.env['CHANNEL_BIND_IP'] ?? '127.0.0.1',
    });
    return new Promise((resolve, reject) => {
      client.GetCapacity({}, (err: Error | null, response: any) => {
        if (err) {
          span.recordException(err);
          try { span.end(); } catch { /* swallow */ }
          return reject(err);
        }
        span.setAttribute('patter.container.active_calls', response.activeCalls ?? 0);
        span.setAttribute('patter.container.max_slots', response.maxSlots ?? 15);
        span.setAttribute('patter.container.memory_rss_mb', response.memoryRssMb ?? 0);
        try { span.end(); } catch { /* swallow */ }
        resolve({
          containerId: response.containerId ?? 'cpp-container',
          status: response.status ?? 'HEALTHY',
          activeCalls: response.activeCalls ?? 0,
          maxSlots: response.maxSlots ?? 15,
          availableSlots: response.availableSlots ?? 15,
          memoryRssMb: response.memoryRssMb ?? 0,
          cpuUtilizationPct: response.cpuUtilizationPct ?? 0,
          uptimeSeconds: Number(response.uptimeSeconds ?? 0),
          isCoolingDown: response.isCoolingDown ?? false,
        });
      });
    });
  }

  /**
   * Open a bi-directional streaming connection to C++ for 20ms PCM audio frames.
   */
  async createAudioStream(onEvent: (evt: GrpcInferenceEvent) => void): Promise<{
    sendFrame: (callSessionId: string, pcm16Data: Buffer, sequenceNumber?: number) => void;
    close: () => void;
  }> {
    const client = await this.getClient();
    const stream = client.StreamAudio();
    const callSequences = new Map<string, number>();

    const streamSpan = startSpan(SPAN_GRPC_STREAM, {
      'patter.grpc.target': this.target,
      'patter.grpc.port': 50051,
      'patter.grpc.method': 'StreamAudio',
      'patter.channel.bind_ip': process.env['CHANNEL_BIND_IP'] ?? '127.0.0.1',
    });

    stream.on('data', (res: any) => {
      try {
        streamSpan.addEvent('grpc.inference_frame', {
          'patter.call.id': res.callSessionId ?? '',
          'patter.cpp.inference_us': Number(res.cppInferenceUs ?? 0),
          'patter.node.roundtrip_ms': Number(res.nodeRoundtripMs ?? 0),
          'patter.vad.score': Number(res.vadScore ?? 0),
          'patter.eos.score': Number(res.eosScore ?? 0),
        });
      } catch { /* swallow */ }
      onEvent({
        callSessionId: res.callSessionId,
        vadScore: res.vadScore ?? 0,
        eosScore: res.eosScore ?? 0,
        isUserSpeaking: res.isUserSpeaking ?? false,
        isTurnComplete: res.isTurnComplete ?? false,
        blockNumber: Number(res.blockNumber ?? 0),
      });
    });

    stream.on('error', (err: Error) => {
      streamSpan.recordException(err);
      getLogger().warn(`[PATTER] gRPC AudioStream error: ${err.message}`);
    });

    return {
      sendFrame: (callSessionId: string, pcm16Data: Buffer, sequenceNumber?: number) => {
        const seq = sequenceNumber ?? (callSequences.get(callSessionId) ?? 0);
        callSequences.set(callSessionId, seq + 1);
        stream.write({ callSessionId, pcm16Data, sequenceNumber: seq });
      },
      close: () => {
        stream.end();
        try { streamSpan.end(); } catch { /* swallow */ }
      },
    };
  }
}
