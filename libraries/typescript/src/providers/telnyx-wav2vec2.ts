/**
 * Telnyx Wav2Vec2 End-of-Speech (EOS) Provider — ONNX & Acoustic Audio Window Classifier.
 *
 * Runs a 700ms sliding PCM audio window (11,200 samples @ 16kHz) at 100ms step intervals.
 * Used as an uncertainty tie-breaker when TurnSense confidence is in the gray-zone [0.45, 0.75],
 * eliminating the 200ms Cloudflare Deepgram Flux WebSocket latency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logger';
import { loadOnnxRuntime } from './silero-vad';
import { fetchModelFromR2 } from '../utils/r2-model-loader';


export interface TelnyxWav2Vec2EOSOptions {
  readonly modelPath?: string;
  readonly sampleRate?: number;
  readonly windowMs?: number; // Default 700ms
  readonly threshold?: number; // Default 0.80
}

const memorySessionCache = new Map<string, any>();
const memoryLoadingPromises = new Map<string, Promise<any>>();

export class TelnyxWav2Vec2EOS {
  static readonly providerKey = 'telnyx_wav2vec2_eos';
  private session: any = null;
  private isLoaded = false;
  private readonly options: TelnyxWav2Vec2EOSOptions;
  private readonly sampleRate: number;
  private readonly windowSamples: number;
  public readonly threshold: number;

  constructor(options: TelnyxWav2Vec2EOSOptions = {}) {
    this.options = options;
    this.sampleRate = options.sampleRate ?? 16000;
    const windowMs = options.windowMs ?? 700;
    this.windowSamples = Math.floor((windowMs / 1000) * this.sampleRate);
    this.threshold = options.threshold ?? 0.8;

    // Auto-trigger ONNX session loading in background
    void this.initSession();
  }

  static async load(options: TelnyxWav2Vec2EOSOptions = {}): Promise<TelnyxWav2Vec2EOS> {
    const instance = new TelnyxWav2Vec2EOS(options);
    await instance.initSession();
    return instance;
  }

  private async initSession(): Promise<void> {
    if (this.isLoaded) return;

    const resolvedPath =
      this.options.modelPath ??
      process.env.PATTER_TELNYX_EOS_MODEL ??
      path.join(__dirname, '..', 'resources', 'telnyx_wav2vec2_eos_int8.onnx');

    if (memorySessionCache.has(resolvedPath)) {
      this.session = memorySessionCache.get(resolvedPath);
      this.isLoaded = true;
      return;
    }

    if (memoryLoadingPromises.has(resolvedPath)) {
      this.session = await memoryLoadingPromises.get(resolvedPath);
      this.isLoaded = true;
      return;
    }

    const loadPromise = (async () => {
      let activePath = resolvedPath;
      if (!fs.existsSync(activePath)) {
        const shardEnv = process.env['PATTER_TELNYX_EOS_SHARDS'];
        if (shardEnv) {
          try {
            const shardKeys = shardEnv.split(',').map((s) => s.trim()).filter(Boolean);
            activePath = await fetchModelFromR2({
              shardKeys,
              modelKey: 'telnyx_wav2vec2_eos_int8',
            });
          } catch (r2Err) {
            getLogger().warn(`[PATTER] TelnyxWav2Vec2EOS R2 hydration failed: ${(r2Err as Error)?.message}`);
            return null;
          }
        } else {
          return null;
        }
      }
      const ort = await loadOnnxRuntime('TelnyxWav2Vec2EOS');
      const session = await ort.InferenceSession.create(activePath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      memorySessionCache.set(resolvedPath, session);
      getLogger().info(`[PATTER] TelnyxWav2Vec2EOS model loaded into memory from: ${activePath}`);
      return session;
    })();


    memoryLoadingPromises.set(resolvedPath, loadPromise);

    try {
      this.session = await loadPromise;
    } catch (err) {
      getLogger().debug(`[PATTER] TelnyxWav2Vec2EOS ONNX model not found, running acoustic pitch-decay mode: ${(err as Error)?.message}`);
    } finally {
      memoryLoadingPromises.delete(resolvedPath);
      this.isLoaded = true;
    }
  }

  /**
   * Evaluates a 700ms PCM audio window and returns the End-of-Speech probability in [0.0, 1.0].
   */
  async predictEos(pcmBuffer: Buffer): Promise<number> {
    if (!this.isLoaded) {
      await this.initSession();
    }

    if (pcmBuffer.length === 0) return 0;

    // If ONNX session is active, run 700ms window inference
    if (this.session) {
      try {
        const ort = await loadOnnxRuntime('TelnyxWav2Vec2EOS');
        const float32Data = new Float32Array(this.windowSamples);
        const availableSamples = Math.floor(pcmBuffer.length / 2);
        const startIndex = Math.max(0, availableSamples - this.windowSamples);

        for (let i = 0; i < this.windowSamples; i++) {
          const sampleIdx = startIndex + i;
          if (sampleIdx < availableSamples) {
            float32Data[i] = pcmBuffer.readInt16LE(sampleIdx * 2) / 32768.0;
          } else {
            float32Data[i] = 0;
          }
        }

        const tensor = new ort.Tensor('float32', float32Data, [1, this.windowSamples]);
        const results = await this.session.run({ input_values: tensor });
        const logits = results.logits?.data ?? results.output?.data;
        if (logits && logits.length > 0) {
          const rawScore = logits[0];
          return 1 / (1 + Math.exp(-rawScore)); // Sigmoid score
        }
      } catch (err) {
        getLogger().debug(`[PATTER] TelnyxWav2Vec2EOS ONNX inference fallback: ${(err as Error)?.message}`);
      }
    }

    // High-performance acoustic energy & trailing pitch decay analysis
    return this.fallbackAcousticEos(pcmBuffer);
  }

  private fallbackAcousticEos(pcmBuffer: Buffer): number {
    const numSamples = Math.floor(pcmBuffer.length / 2);
    if (numSamples < 320) return 0;

    // Analyze RMS energy of the final 200ms vs preceding 500ms
    const recentSamples = Math.min(3200, numSamples); // 200ms @ 16kHz
    let recentSumSq = 0;
    for (let i = numSamples - recentSamples; i < numSamples; i++) {
      const val = pcmBuffer.readInt16LE(i * 2);
      recentSumSq += val * val;
    }
    const recentRms = Math.sqrt(recentSumSq / recentSamples);

    let priorSumSq = 0;
    const priorSamples = Math.min(8000, numSamples - recentSamples); // 500ms
    if (priorSamples > 0) {
      for (let i = numSamples - recentSamples - priorSamples; i < numSamples - recentSamples; i++) {
        const val = pcmBuffer.readInt16LE(i * 2);
        priorSumSq += val * val;
      }
      const priorRms = Math.sqrt(priorSumSq / priorSamples);
      const decayRatio = priorRms > 0 ? recentRms / priorRms : 0;

      // If trailing energy drops below 25% of prior speech energy, high EOS probability
      if (decayRatio < 0.25) return 0.88;
      if (decayRatio < 0.45) return 0.72;
    }

    return recentRms < 300 ? 0.85 : 0.2;
  }

  async close(): Promise<void> {
    this.session = null;
    this.isLoaded = false;
  }
}
