/**
 * Speech Emotion Recognition Provider (Wav2Vec2 ONNX).
 *
 * Model: onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX
 * Analyzes audio PCM streams to predict real-time speaker emotions
 * (happy, sad, angry, neutral, fear, disgust, surprise).
 */

import type { OnnxInferenceSession, OnnxRuntime } from './silero-vad';
import { loadOnnxRuntime } from './silero-vad';
import { getLogger } from '../logger';
import { fetchModelFromR2 } from '../utils/r2-model-loader';

export interface EmotionPrediction {
  readonly emotion: 'happy' | 'sad' | 'angry' | 'neutral' | 'fear' | 'disgust' | 'surprise';
  readonly score: number;
  readonly probabilities: Record<string, number>;
}

export interface SpeechEmotionOptions {
  readonly modelPath?: string;
  readonly shardKeys?: readonly string[];
  readonly threshold?: number;
}

const EMOTION_LABELS = ['angry', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise'] as const;

export class SpeechEmotionDetector {
  private runtime: OnnxRuntime | null = null;
  private session: OnnxInferenceSession | null = null;
  private closed = false;
  public readonly threshold: number;

  constructor(opts: SpeechEmotionOptions = {}) {
    this.threshold = opts.threshold ?? 0.4;
  }

  static async load(opts: SpeechEmotionOptions = {}): Promise<SpeechEmotionDetector> {
    const detector = new SpeechEmotionDetector(opts);
    await detector.init(opts);
    return detector;
  }

  private async init(opts: SpeechEmotionOptions): Promise<void> {
    try {
      let modelFile = opts.modelPath ?? process.env['PATTER_EMOTION_MODEL'];

      if (!modelFile && (opts.shardKeys || process.env['PATTER_EMOTION_SHARDS'])) {
        const shardKeys = opts.shardKeys ?? process.env['PATTER_EMOTION_SHARDS']?.split(',');
        if (shardKeys && shardKeys.length > 0) {
          modelFile = await fetchModelFromR2({
            modelKey: 'speech_emotion',
            shardKeys,
          });
        }
      }

      if (!modelFile) {
        getLogger().info('[PATTER] SpeechEmotionDetector: no ONNX model configured — using heuristic fallback');
        return;
      }

      this.runtime = await loadOnnxRuntime();
      this.session = await this.runtime.InferenceSession.create(modelFile, {
        executionProviders: ['cpu'],
      });
      getLogger().info(`[PATTER] SpeechEmotionDetector: loaded model from ${modelFile}`);
    } catch (err) {
      getLogger().warn(`[PATTER] SpeechEmotionDetector init error: ${(err as Error).message}`);
    }
  }

  async predict(pcmFloat32: Float32Array): Promise<EmotionPrediction> {
    if (this.closed) throw new Error('SpeechEmotionDetector is closed');

    if (!this.session || !this.runtime) {
      return this.heuristicFallback(pcmFloat32);
    }

    try {
      const tensor = new this.runtime.Tensor('float32', pcmFloat32, [1, pcmFloat32.length]);
      const feeds = { input_values: tensor };
      const results = await this.session.run(feeds);
      const outputKey = Object.keys(results)[0];
      const logits = results[outputKey].data as Float32Array;

      const probabilities = this.softmax(Array.from(logits));
      let maxIdx = 0;
      let maxProb = -1;

      const probMap: Record<string, number> = {};
      EMOTION_LABELS.forEach((label, i) => {
        const prob = probabilities[i] ?? 0;
        probMap[label] = Math.round(prob * 1000) / 1000;
        if (prob > maxProb) {
          maxProb = prob;
          maxIdx = i;
        }
      });

      return {
        emotion: EMOTION_LABELS[maxIdx] ?? 'neutral',
        score: Math.round(maxProb * 1000) / 1000,
        probabilities: probMap,
      };
    } catch (err) {
      getLogger().warn(`[PATTER] SpeechEmotionDetector prediction error: ${(err as Error).message}`);
      return this.heuristicFallback(pcmFloat32);
    }
  }

  private softmax(logits: number[]): number[] {
    const maxLogit = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sumExps);
  }

  private heuristicFallback(pcm: Float32Array): EmotionPrediction {
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
    const rms = Math.sqrt(sumSq / Math.max(1, pcm.length));

    const isHighEnergy = rms > 0.15;
    const emotion = isHighEnergy ? 'angry' : 'neutral';
    const score = isHighEnergy ? 0.65 : 0.85;

    return {
      emotion,
      score,
      probabilities: {
        angry: isHighEnergy ? 0.65 : 0.05,
        neutral: isHighEnergy ? 0.15 : 0.85,
        happy: 0.10,
        sad: 0.05,
        fear: 0.02,
        disgust: 0.02,
        surprise: 0.01,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.session = null;
  }
}
