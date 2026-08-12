/**
 * TenVAD Provider — High-performance acoustic voice activity detector for telephony pipelines.
 *
 * Implements {@link VADProvider}. Supports auto-loading from default model paths,
 * in-memory session caching for instant re-instantiation across calls, and ONNX Runtime inference.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { VADEvent, VADProvider } from '../types';
import {
  loadOnnxRuntime,
  type OnnxInferenceSession,
  type OnnxRuntime,
} from './silero-vad';
import { getLogger } from '../logger';
import { fetchModelFromR2 } from '../utils/r2-model-loader';
import { startSpan, SPAN_ONNX_INFERENCE } from '../observability';


export const TENVAD_MODEL_ENV_VAR = 'PATTER_TENVAD_MODEL';

// Process-wide in-memory cache for loaded ONNX sessions
const memorySessionCache = new Map<string, { runtime: OnnxRuntime; session: OnnxInferenceSession }>();

function resolveModuleDirs(): readonly string[] {
  const candidates: string[] = [];
  try {
    const cjsDir = new Function("return typeof __dirname !== 'undefined' ? __dirname : null")();
    if (typeof cjsDir === 'string') candidates.push(cjsDir);
  } catch { /* ignore */ }

  try {
    const url = (import.meta as { url?: string }).url;
    if (url) candidates.push(path.dirname(fileURLToPath(url)));
  } catch { /* ignore */ }

  try {
    const url = (import.meta as { url?: string }).url;
    if (url) {
      const req = createRequire(url);
      candidates.push(path.dirname(req.resolve('getpatter/package.json')));
    }
  } catch { /* ignore */ }

  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    candidates.push(path.dirname(req.resolve('getpatter/package.json')));
  } catch { /* ignore */ }

  candidates.push(process.cwd());
  return candidates;
}

const MODULE_DIRS = resolveModuleDirs();
function resolveDefaultTenVadModelPath(): string | null {
  for (const dir of MODULE_DIRS) {
    const candidates = [
      path.join(dir, 'resources', 'ten_vad.onnx'),
      path.join(dir, 'resources', 'silero_vad.onnx'),
      path.join(dir, '..', 'resources', 'ten_vad.onnx'),
      path.join(dir, '..', 'resources', 'silero_vad.onnx'),
      path.join(dir, 'dist', 'resources', 'ten_vad.onnx'),
      path.join(dir, 'dist', 'resources', 'silero_vad.onnx'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  return null;
}

export interface TenVADOptions {
  /** Speech activation threshold in [0, 1]. Default 0.75. */
  readonly activationThreshold?: number;
  /** Speech deactivation threshold in [0, 1]. Default 0.4. */
  readonly deactivationThreshold?: number;
  /** Minimum speech duration (seconds) before emitting speech_start. Default 0.25. */
  readonly minSpeechDuration?: number;
  /** Minimum silence duration (seconds) before emitting speech_end. Default 0.4. */
  readonly minSilenceDuration?: number;
  /** Barge-in threshold (ms) — speech shorter than this during TTS is treated as noise/cough. Default 300. */
  readonly bargeInThresholdMs?: number;
  /** Sample rate (Hz). Supported: 8000, 16000. Default 16000. */
  readonly sampleRate?: number;
  /** Path to custom TenVAD `.onnx` model file. Falls back to `PATTER_TENVAD_MODEL` env var. */
  readonly onnxFilePath?: string;
  /** Restrict ONNX Runtime to CPU (default true). */
  readonly forceCpu?: boolean;
}

export class TenVAD implements VADProvider {
  readonly sampleRate: number;
  private readonly activationThreshold: number;
  private readonly deactivationThreshold: number;
  private readonly minSpeechDuration: number;
  private readonly minSilenceDuration: number;
  readonly bargeInThresholdMs: number;

  private runtime: OnnxRuntime | null = null;
  private session: OnnxInferenceSession | null = null;
  private initPromise: Promise<void> | null = null;
  private rnnState: Float32Array = new Float32Array(2 * 1 * 128);

  private pending: Float32Array = new Float32Array(0);
  private isSpeaking = false;
  private speechDurationSec = 0;
  private silenceDurationSec = 0;
  private eventQueue: VADEvent[] = [];
  private closed = false;

  constructor(options: TenVADOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    if (this.sampleRate !== 8000 && this.sampleRate !== 16000) {
      throw new Error('TenVAD supports 8000 Hz and 16000 Hz sample rates');
    }
    this.activationThreshold = options.activationThreshold ?? 0.75;
    this.deactivationThreshold = options.deactivationThreshold ?? 0.4;
    this.minSpeechDuration = options.minSpeechDuration ?? 0.25;
    this.minSilenceDuration = options.minSilenceDuration ?? 0.4;
    this.bargeInThresholdMs = options.bargeInThresholdMs ?? 300;

    const rawPath = options.onnxFilePath ?? process.env[TENVAD_MODEL_ENV_VAR] ?? resolveDefaultTenVadModelPath();
    if (rawPath) {
      this.initPromise = this.initOnnxSession(rawPath, options.forceCpu);
    }
  }

  private async initOnnxSession(rawPath: string, forceCpu?: boolean): Promise<void> {
    try {
      let modelPath = path.resolve(rawPath);
      if (memorySessionCache.has(modelPath)) {
        const cached = memorySessionCache.get(modelPath)!;
        this.runtime = cached.runtime;
        this.session = cached.session;
        return;
      }

      if (!fs.existsSync(modelPath)) {
        const shardEnv = process.env['PATTER_TENVAD_SHARDS'];
        if (shardEnv) {
          try {
            const shardKeys = shardEnv.split(',').map((s) => s.trim()).filter(Boolean);
            modelPath = await fetchModelFromR2({ shardKeys, modelKey: 'ten_vad' });
          } catch (r2Err) {
            getLogger().warn(`TenVAD R2 hydration failed: ${(r2Err as Error).message}`);
            return;
          }
        } else {
          return;
        }
      }

      this.runtime = await loadOnnxRuntime('TenVAD');
      this.session = await this.runtime.InferenceSession.create(modelPath, {
        interOpNumThreads: 1,
        intraOpNumThreads: 1,
        executionMode: 'sequential',
        executionProviders: forceCpu === false ? undefined : ['cpu'],
      });

      memorySessionCache.set(modelPath, { runtime: this.runtime, session: this.session });
      getLogger().info(`TenVAD model loaded into memory from: ${modelPath}`);
    } catch (err) {
      getLogger().warn(`TenVAD ONNX memory load failed — falling back to acoustic mode: ${String(err)}`);
    }
  }


  /** Static factory for explicit async loading. */
  static async load(options: TenVADOptions = {}): Promise<TenVAD> {
    const vad = new TenVAD(options);
    if (vad.initPromise) {
      await vad.initPromise;
    }
    return vad;
  }

  numFramesRequired(): number {
    return this.sampleRate === 8000 ? 256 : 512;
  }

  async processFrame(pcmChunk: Buffer, sampleRate: number): Promise<VADEvent | null> {
    if (this.closed) {
      throw new Error('TenVAD is closed');
    }
    if (sampleRate !== this.sampleRate) {
      throw new Error(`Sample rate mismatch: expected ${this.sampleRate}, got ${sampleRate}`);
    }
    if (this.initPromise) {
      await this.initPromise;
    }
    if (pcmChunk.length === 0) {
      return this.eventQueue.shift() ?? null;
    }

    const numSamples = Math.floor(pcmChunk.length / 2);
    if (numSamples === 0) return this.eventQueue.shift() ?? null;

    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      samples[i] = pcmChunk.readInt16LE(i * 2) / 32768;
    }

    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending, 0);
    merged.set(samples, this.pending.length);
    this.pending = merged;

    const windowSize = this.numFramesRequired();
    const frameDurationSec = windowSize / this.sampleRate;

    while (this.pending.length >= windowSize) {
      const window = this.pending.subarray(0, windowSize);
      this.pending = this.pending.subarray(windowSize);

      let score: number;
      if (this.session && this.runtime) {
        score = await this.runOnnxInference(window);
      } else {
        score = this.calculateSpeechProbability(window);
      }

      const transition = this.advanceState(score, frameDurationSec);
      if (transition) {
        this.eventQueue.push(transition);
      }
    }

    return this.eventQueue.shift() ?? null;
  }

  private async runOnnxInference(window: Float32Array): Promise<number> {
    if (!this.runtime || !this.session) return 0;
    const { Tensor } = this.runtime;
    const feeds = {
      input: new Tensor('float32', window, [1, window.length]),
      state: new Tensor('float32', this.rnnState, [2, 1, 128]),
    };
    const start = Date.now();
    const span = startSpan(SPAN_ONNX_INFERENCE, {
      'patter.onnx.model_name': 'ten_vad',
      'patter.onnx.sample_rate': this.sampleRate,
    });
    try {
      const results = await this.session.run(feeds);
      const outputKey = Object.keys(results).find((k) => k !== 'stateN') ?? 'output';
      const out = results[outputKey];
      const data = out?.data as Float32Array | undefined;
      const score = data?.[0] ?? 0;
      span.setAttribute('patter.vad.score', score);
      span.setAttribute('patter.onnx.inference_ms', Date.now() - start);
      return score;
    } catch (err) {
      span.recordException(err as Error);
      return this.calculateSpeechProbability(window);
    } finally {
      try { span.end(); } catch { /* swallow */ }
    }
  }

  private calculateSpeechProbability(window: Float32Array): number {
    let sumSq = 0;
    for (let i = 0; i < window.length; i++) {
      sumSq += window[i] * window[i];
    }
    const rms = Math.sqrt(sumSq / window.length);
    const dbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -60;

    const minDbfs = -45;
    const maxDbfs = -15;
    if (dbfs <= minDbfs) return 0.0;
    if (dbfs >= maxDbfs) return 1.0;
    return (dbfs - minDbfs) / (maxDbfs - minDbfs);
  }

  reset(): void {
    if (this.closed) return;
    this.pending = new Float32Array(0);
    this.isSpeaking = false;
    this.speechDurationSec = 0;
    this.silenceDurationSec = 0;
    this.eventQueue = [];
    this.rnnState = new Float32Array(2 * 1 * 128);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session = null;
    this.reset();
  }

  private advanceState(score: number, frameDurationSec: number): VADEvent | null {
    const isSpeechFrame =
      score >= this.activationThreshold ||
      (this.isSpeaking && score > this.deactivationThreshold);

    if (isSpeechFrame) {
      this.speechDurationSec += frameDurationSec;
      this.silenceDurationSec = 0;

      if (!this.isSpeaking && this.speechDurationSec >= this.minSpeechDuration) {
        this.isSpeaking = true;
        return {
          type: 'speech_start',
          confidence: score,
          durationMs: Math.round(this.speechDurationSec * 1000),
        };
      }
    } else {
      this.silenceDurationSec += frameDurationSec;
      this.speechDurationSec = 0;

      if (this.isSpeaking && this.silenceDurationSec >= this.minSilenceDuration) {
        this.isSpeaking = false;
        return {
          type: 'speech_end',
          confidence: score,
          durationMs: Math.round(this.silenceDurationSec * 1000),
        };
      }
    }
    return null;
  }
}
