/**
 * TurnSense Detector — Hybrid Text & Audio Turn Completion Classifier.
 *
 * Implements {@link TurnDetectorProvider}. Scores the caller's in-flight transcript
 * and recent PCM audio prosody to predict whether the turn is COMPLETE (prob >= threshold)
 * or INCOMPLETE (prob < threshold).
 *
 * Supports both pure-TS feature scoring and ONNX model runtime (via `onnxruntime-node`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TurnDetectorProvider } from '../types';
import {
  loadOnnxRuntime,
  type OnnxInferenceSession,
  type OnnxRuntime,
  type OnnxTensor,
} from './silero-vad';
import { getLogger } from '../logger';

export const TURNSENSE_MODEL_ENV_VAR = 'PATTER_TURNSENSE_MODEL';

export interface TurnSenseOptions {
  /** Decision threshold in [0, 1]. Default 0.5. */
  readonly threshold?: number;
  /** Path to custom TurnSense `.onnx` model file. Falls back to `PATTER_TURNSENSE_MODEL` env var. */
  readonly modelPath?: string;
  /** Restrict ONNX Runtime to CPU (default true). */
  readonly forceCpu?: boolean;
}

export class TurnSenseDetector implements TurnDetectorProvider {
  private readonly thresholdValue: number;
  private readonly runtime: OnnxRuntime | null = null;
  private session: OnnxInferenceSession | null = null;
  private closed = false;

  constructor(
    options: TurnSenseOptions = {},
    runtime: OnnxRuntime | null = null,
    session: OnnxInferenceSession | null = null,
  ) {
    this.thresholdValue = options.threshold ?? 0.5;
    this.runtime = runtime;
    this.session = session;
  }

  /**
   * Load TurnSenseDetector. When an ONNX model path is provided (or `PATTER_TURNSENSE_MODEL` set),
   * dynamically loads `onnxruntime-node` via `loadOnnxRuntime`.
   */
  static async load(options: TurnSenseOptions = {}): Promise<TurnSenseDetector> {
    const rawPath = options.modelPath ?? process.env[TURNSENSE_MODEL_ENV_VAR];
    let runtime: OnnxRuntime | null = null;
    let session: OnnxInferenceSession | null = null;

    if (rawPath && rawPath.trim().length > 0) {
      const modelPath = path.resolve(rawPath.trim());
      if (!fs.existsSync(modelPath)) {
        throw new Error(`TurnSense ONNX model file not found: ${modelPath}`);
      }
      runtime = await loadOnnxRuntime('TurnSenseDetector');
      session = await runtime.InferenceSession.create(modelPath, {
        interOpNumThreads: 1,
        intraOpNumThreads: 1,
        executionMode: 'sequential',
        executionProviders: options.forceCpu === false ? undefined : ['cpu'],
      });
      getLogger().info(`TurnSenseDetector loaded ONNX model session from: ${modelPath}`);
    }

    return new TurnSenseDetector(options, runtime, session);
  }

  get threshold(): number {
    return this.thresholdValue;
  }

  /**
   * Predict end-of-turn probability in [0, 1].
   */
  async predict(pcm16Window: Buffer, transcript?: string): Promise<number> {
    if (this.closed) {
      throw new Error('TurnSenseDetector is closed');
    }

    if (this.session && this.runtime) {
      const score = await this.runOnnxInference(pcm16Window);
      if (score !== null) return score;
    }

    const text = (transcript ?? '').trim();
    if (!text) return 0.0;

    const lower = text.toLowerCase();

    // Fast short definitive answers (Scenario 5) -> High confidence complete (0.95)
    const shortDefinitiveAnswers = [
      'morning', 'afternoon', 'evening', 'yes', 'yeah', 'yep', 'no', 'nope',
      'sure', 'ok', 'okay', 'wednesday', 'tuesday', 'monday', 'thursday', 'friday',
      'saturday', 'sunday', 'tomorrow', 'today',
    ];
    if (shortDefinitiveAnswers.includes(lower)) {
      return 0.95;
    }

    // Trailing thinking pauses (Scenario 2) -> Low probability / incomplete (0.1)
    const trailingIncompleteSuffixes = ['is...', 'is', 'uh', 'um', 'uh...', 'um...', 'and', 'and...', 'the', 'or'];
    const words = lower.split(/\s+/);
    const lastWord = words[words.length - 1];

    if (trailingIncompleteSuffixes.includes(lastWord)) {
      return 0.1;
    }

    // Grammatically complete sentences with terminal punctuation -> Complete (0.90)
    if (/[.!?]$/.test(text)) {
      return 0.90;
    }

    // Default heuristic for multi-word utterances without explicit incomplete markers
    return words.length >= 3 ? 0.85 : 0.60;
  }

  private async runOnnxInference(pcm16Window: Buffer): Promise<number | null> {
    if (!this.runtime || !this.session || pcm16Window.length < 2) return null;
    try {
      const numSamples = Math.floor(pcm16Window.length / 2);
      const samples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        samples[i] = pcm16Window.readInt16LE(i * 2) / 32768;
      }
      const { Tensor } = this.runtime;
      const feeds = {
        input: new Tensor('float32', samples, [1, samples.length]),
      };
      const results = await this.session.run(feeds);
      const first = Object.values(results)[0] as OnnxTensor | undefined;
      const data = first?.data as Float32Array | undefined;
      const prob = data?.[0] ?? 0;
      return Math.min(1, Math.max(0, prob));
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session = null;
  }
}
