/**
 * Smart-turn v3 semantic turn detector (ONNX & Unified Dual-Gated Pipeline).
 *
 * Composes TurnSenseDetector (text heuristics) + TelnyxWav2Vec2EOS (audio prosody 700ms window @ 100ms step)
 * with ONNX model support for pipecat-ai smart-turn-v3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logger';
import { fetchModelFromR2 } from '../utils/r2-model-loader';
import { startSpan, SPAN_ONNX_INFERENCE } from '../observability';

import type { TurnDetectorProvider } from '../types';
import { TurnSenseDetector } from './turn-sense';
import { TelnyxWav2Vec2EOS } from './telnyx-wav2vec2';
import {
  loadOnnxRuntime,
  type OnnxInferenceSession,
  type OnnxRuntime,
  type OnnxTensor,
} from './silero-vad';

export const SMART_TURN_MODEL_ENV_VAR = 'PATTER_SMART_TURN_MODEL';
export const SMART_TURN_SAMPLE_RATE = 16000;
export const SMART_TURN_MAX_SECONDS = 8;
export const SMART_TURN_MAX_SAMPLES = SMART_TURN_SAMPLE_RATE * SMART_TURN_MAX_SECONDS;
export const DEFAULT_SMART_TURN_THRESHOLD = 0.5;

const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 80;
const N_FRAMES = 800;
const MEL_FLOOR = 1e-10;
const NORM_EPS = 1e-7;

const DOWNLOAD_HINT =
  'Download a smart-turn-v3 ONNX file from ' +
  'https://huggingface.co/pipecat-ai/smart-turn-v3 and either set the ' +
  `${SMART_TURN_MODEL_ENV_VAR} environment variable to its path or pass ` +
  'modelPath to SmartTurnDetector.load().';

export interface SmartTurnDetectorOptions {
  readonly threshold?: number;
  readonly modelPath?: string;
  readonly forceCpu?: boolean;
  readonly turnSensePath?: string;
  readonly telnyxEosPath?: string;
}

export function resolveSmartTurnModelPath(modelPath?: string): string {
  let resolved = modelPath;
  if (!resolved) {
    resolved = (process.env[SMART_TURN_MODEL_ENV_VAR] ?? '').trim();
    if (!resolved) {
      throw new Error(`SmartTurnDetector has no model file configured. ${DOWNLOAD_HINT}`);
    }
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Smart-turn model file not found: ${resolved}. ${DOWNLOAD_HINT}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Smart-turn model path is not a file: ${resolved}. ${DOWNLOAD_HINT}`);
  }
  return path.resolve(resolved);
}

export async function resolveSmartTurnModelPathAsync(modelPath?: string): Promise<string> {
  let resolved = modelPath;
  if (!resolved) {
    resolved = (process.env[SMART_TURN_MODEL_ENV_VAR] ?? '').trim();
  }
  if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return path.resolve(resolved);
  }
  const shardsEnv = process.env['PATTER_SMART_TURN_SHARDS'];
  if (shardsEnv) {
    const shardKeys = shardsEnv.split(',').map((s) => s.trim()).filter(Boolean);
    return await fetchModelFromR2({ shardKeys, modelKey: 'smart_turn_v3' });
  }
  return resolveSmartTurnModelPath(modelPath);
}


function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  if (freq >= minLogHertz) {
    return minLogMel + Math.log(freq / minLogHertz) * logstep;
  }
  return (3.0 * freq) / 200.0;
}

function melToHertzSlaney(mels: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  if (mels >= minLogMel) {
    return minLogHertz * Math.exp(logstep * (mels - minLogMel));
  }
  return (200.0 * mels) / 3.0;
}

interface SparseMelFilter {
  readonly startBin: number;
  readonly weights: Float64Array;
}

let melFilterbankCache: SparseMelFilter[] | null = null;

function melFilterbank(): SparseMelFilter[] {
  if (melFilterbankCache) return melFilterbankCache;

  const numBins = 1 + N_FFT / 2;
  const fftFreqs = new Float64Array(numBins);
  for (let k = 0; k < numBins; k++) {
    fftFreqs[k] = (k * (SMART_TURN_SAMPLE_RATE / 2)) / (numBins - 1);
  }

  const melMin = hertzToMelSlaney(0.0);
  const melMax = hertzToMelSlaney(SMART_TURN_SAMPLE_RATE / 2);
  const filterFreqs = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    filterFreqs[i] = melToHertzSlaney(melMin + ((melMax - melMin) * i) / (N_MELS + 1));
  }

  const filters: SparseMelFilter[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const lower = filterFreqs[m];
    const center = filterFreqs[m + 1];
    const upper = filterFreqs[m + 2];
    const enorm = 2.0 / (upper - lower);
    const dense = new Float64Array(numBins);
    let startBin = -1;
    let endBin = -1;
    for (let k = 0; k < numBins; k++) {
      const down = (fftFreqs[k] - lower) / (center - lower);
      const up = (upper - fftFreqs[k]) / (upper - center);
      const w = Math.max(0, Math.min(down, up)) * enorm;
      dense[k] = w;
      if (w > 0) {
        if (startBin === -1) startBin = k;
        endBin = k;
      }
    }
    if (startBin === -1) {
      filters.push({ startBin: 0, weights: new Float64Array(0) });
    } else {
      filters.push({ startBin, weights: dense.slice(startBin, endBin + 1) });
    }
  }
  melFilterbankCache = filters;
  return filters;
}

let hannWindowCache: Float64Array | null = null;

function hannWindow(): Float64Array {
  if (!hannWindowCache) {
    const w = new Float64Array(N_FFT);
    for (let n = 0; n < N_FFT; n++) {
      w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
    }
    hannWindowCache = w;
  }
  return hannWindowCache;
}

let dft25Cos: Float64Array | null = null;
let dft25Sin: Float64Array | null = null;

function dft25Tables(): { cos: Float64Array; sin: Float64Array } {
  if (!dft25Cos || !dft25Sin) {
    dft25Cos = new Float64Array(25 * 25);
    dft25Sin = new Float64Array(25 * 25);
    for (let k = 0; k < 25; k++) {
      for (let j = 0; j < 25; j++) {
        const angle = (-2 * Math.PI * k * j) / 25;
        dft25Cos[k * 25 + j] = Math.cos(angle);
        dft25Sin[k * 25 + j] = Math.sin(angle);
      }
    }
  }
  return { cos: dft25Cos, sin: dft25Sin };
}

const fftTwiddleCos = new Map<number, Float64Array>();
const fftTwiddleSin = new Map<number, Float64Array>();
const fftScratch = new Map<number, [Float64Array, Float64Array, Float64Array, Float64Array]>();

function fftTables(n: number): { cos: Float64Array; sin: Float64Array } {
  let cos = fftTwiddleCos.get(n);
  let sin = fftTwiddleSin.get(n);
  if (!cos || !sin) {
    const half = n / 2;
    cos = new Float64Array(half);
    sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const angle = (-2 * Math.PI * k) / n;
      cos[k] = Math.cos(angle);
      sin[k] = Math.sin(angle);
    }
    fftTwiddleCos.set(n, cos);
    fftTwiddleSin.set(n, sin);
  }
  return { cos, sin };
}

function fftScratchFor(n: number): [Float64Array, Float64Array, Float64Array, Float64Array] {
  let bufs = fftScratch.get(n);
  if (!bufs) {
    bufs = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    fftScratch.set(n, bufs);
  }
  return bufs;
}

const dft25OutRe = new Float64Array(25);
const dft25OutIm = new Float64Array(25);

function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 25) {
    const { cos, sin } = dft25Tables();
    for (let k = 0; k < 25; k++) {
      let sumRe = 0;
      let sumIm = 0;
      const row = k * 25;
      for (let j = 0; j < 25; j++) {
        const c = cos[row + j];
        const s = sin[row + j];
        sumRe += re[j] * c - im[j] * s;
        sumIm += re[j] * s + im[j] * c;
      }
      dft25OutRe[k] = sumRe;
      dft25OutIm[k] = sumIm;
    }
    re.set(dft25OutRe);
    im.set(dft25OutIm);
    return;
  }
  if (n === 1) return;
  const half = n / 2;
  const [evenRe, evenIm, oddRe, oddIm] = fftScratchFor(half);
  for (let i = 0; i < half; i++) {
    evenRe[i] = re[2 * i];
    evenIm[i] = im[2 * i];
    oddRe[i] = re[2 * i + 1];
    oddIm[i] = im[2 * i + 1];
  }
  fftComplex(evenRe.subarray(0, half), evenIm.subarray(0, half));
  fftComplex(oddRe.subarray(0, half), oddIm.subarray(0, half));
  const { cos, sin } = fftTables(n);
  for (let k = 0; k < half; k++) {
    const wr = cos[k];
    const wi = sin[k];
    const tr = wr * oddRe[k] - wi * oddIm[k];
    const ti = wr * oddIm[k] + wi * oddRe[k];
    re[k] = evenRe[k] + tr;
    im[k] = evenIm[k] + ti;
    re[k + half] = evenRe[k] - tr;
    im[k + half] = evenIm[k] - ti;
  }
}

export function prepareInputWindow(samples: ArrayLike<number>): Float64Array {
  const out = new Float64Array(SMART_TURN_MAX_SAMPLES);
  const n = samples.length;
  if (n >= SMART_TURN_MAX_SAMPLES) {
    const offset = n - SMART_TURN_MAX_SAMPLES;
    for (let i = 0; i < SMART_TURN_MAX_SAMPLES; i++) out[i] = samples[offset + i];
  } else {
    const padding = SMART_TURN_MAX_SAMPLES - n;
    for (let i = 0; i < n; i++) out[padding + i] = samples[i];
  }

  let mean = 0;
  for (let i = 0; i < SMART_TURN_MAX_SAMPLES; i++) mean += out[i];
  mean /= SMART_TURN_MAX_SAMPLES;
  let variance = 0;
  for (let i = 0; i < SMART_TURN_MAX_SAMPLES; i++) {
    const d = out[i] - mean;
    variance += d * d;
  }
  variance /= SMART_TURN_MAX_SAMPLES;
  const scale = 1 / Math.sqrt(variance + NORM_EPS);
  for (let i = 0; i < SMART_TURN_MAX_SAMPLES; i++) out[i] = (out[i] - mean) * scale;
  return out;
}

export async function computeWhisperLogMelFeatures(window: Float64Array): Promise<Float32Array> {
  if (window.length !== SMART_TURN_MAX_SAMPLES) {
    throw new Error(`expected ${SMART_TURN_MAX_SAMPLES} samples, got ${window.length}; run prepareInputWindow() first`);
  }

  const half = N_FFT / 2;
  const paddedLen = SMART_TURN_MAX_SAMPLES + N_FFT;
  const numBins = 1 + N_FFT / 2;

  const padded = new Float64Array(paddedLen);
  for (let i = 0; i < half; i++) padded[i] = window[half - i];
  padded.set(window, half);
  for (let i = 0; i < half; i++) {
    padded[half + SMART_TURN_MAX_SAMPLES + i] = window[SMART_TURN_MAX_SAMPLES - 2 - i];
  }

  const hann = hannWindow();
  const filters = melFilterbank();
  const totalFrames = 1 + Math.floor((paddedLen - N_FFT) / HOP_LENGTH);

  const logSpec = new Float64Array(N_MELS * N_FRAMES);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(numBins);
  let maxLog = -Infinity;

  for (let t = 0; t < totalFrames - 1; t++) {
    const start = t * HOP_LENGTH;
    for (let j = 0; j < N_FFT; j++) {
      re[j] = padded[start + j] * hann[j];
      im[j] = 0;
    }
    fftComplex(re, im);
    for (let k = 0; k < numBins; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }
    for (let m = 0; m < N_MELS; m++) {
      const { startBin, weights } = filters[m];
      let acc = 0;
      for (let j = 0; j < weights.length; j++) {
        acc += power[startBin + j] * weights[j];
      }
      const v = Math.log10(Math.max(acc, MEL_FLOOR));
      logSpec[m * N_FRAMES + t] = v;
      if (v > maxLog) maxLog = v;
    }
    if ((t & 127) === 127) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const floor = maxLog - 8.0;
  const out = new Float32Array(N_MELS * N_FRAMES);
  for (let i = 0; i < logSpec.length; i++) {
    out[i] = (Math.max(logSpec[i], floor) + 4.0) / 4.0;
  }
  return out;
}

export async function featuresFromPcm16(pcm16Window: Buffer): Promise<Float32Array> {
  const numSamples = Math.floor(pcm16Window.length / 2);
  const samples = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = pcm16Window.readInt16LE(i * 2) / 32768;
  }
  return computeWhisperLogMelFeatures(prepareInputWindow(samples));
}

export class SmartTurnDetector implements TurnDetectorProvider {
  private closed = false;
  private readonly turnSense: TurnSenseDetector;
  private readonly telnyxEOS: TelnyxWav2Vec2EOS;

  private constructor(
    private readonly runtime: OnnxRuntime | null,
    private session: OnnxInferenceSession | null,
    private readonly thresholdValue: number,
    options: SmartTurnDetectorOptions = {}
  ) {
    this.turnSense = new TurnSenseDetector({ modelPath: options.turnSensePath });
    this.telnyxEOS = new TelnyxWav2Vec2EOS({ modelPath: options.telnyxEosPath });
  }

  static async load(options: SmartTurnDetectorOptions = {}): Promise<SmartTurnDetector> {
    const threshold = options.threshold ?? DEFAULT_SMART_TURN_THRESHOLD;
    if (!(threshold >= 0 && threshold <= 1)) {
      throw new Error('threshold must be within [0.0, 1.0]');
    }

    const modelPath = await resolveSmartTurnModelPathAsync(options.modelPath);
    const runtime = await loadOnnxRuntime('SmartTurnDetector');
    const session = await runtime.InferenceSession.create(modelPath, {
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      executionProviders: options.forceCpu === false ? undefined : ['cpu'],
    });
    return new SmartTurnDetector(runtime, session, threshold, options);
  }

  static async maybeLoad(options: SmartTurnDetectorOptions = {}): Promise<SmartTurnDetector | undefined> {
    const threshold = options.threshold ?? DEFAULT_SMART_TURN_THRESHOLD;
    if (!(threshold >= 0 && threshold <= 1)) {
      throw new Error('threshold must be within [0.0, 1.0]');
    }
    try {
      return await SmartTurnDetector.load(options);
    } catch (err) {
      getLogger().warn(
        'Semantic turn detection unavailable — falling back to plain ' +
          `VAD-silence endpointing: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  static fromOnnxSession(runtime: OnnxRuntime, session: OnnxInferenceSession, options: { threshold?: number } = {}): SmartTurnDetector {
    return new SmartTurnDetector(runtime, session, options.threshold ?? DEFAULT_SMART_TURN_THRESHOLD);
  }

  get model(): string {
    return 'smart-turn-v3';
  }

  get provider(): string {
    return 'ONNX';
  }

  get sampleRate(): number {
    return SMART_TURN_SAMPLE_RATE;
  }

  get maxWindowSeconds(): number {
    return SMART_TURN_MAX_SECONDS;
  }

  get threshold(): number {
    return this.thresholdValue;
  }

  /**
   * Unified Dual-Gated Turn Detection:
   * 1. If ONNX smart-turn session exists, runs ONNX session prediction on log-mel features.
   * 2. Otherwise, runs TurnSense text heuristics + TelnyxWav2Vec2EOS 700ms audio tie-breaker in gray-zone!
   */
  async predict(pcm16Window: Buffer, transcript?: string): Promise<number> {
    if (this.closed) {
      throw new Error('SmartTurnDetector is closed');
    }
    if (pcm16Window.length < 2 && !transcript) {
      return 0;
    }

    // 1. If ONNX session is loaded (smart-turn-v3.onnx), run feature extraction & model inference
    if (this.session && this.runtime) {
      const startMs = Date.now();
      const span = startSpan(SPAN_ONNX_INFERENCE, {
        'patter.onnx.model_name': 'smart_turn_v3',
        'patter.onnx.sample_rate': SMART_TURN_SAMPLE_RATE,
      });
      try {
        const features = await featuresFromPcm16(pcm16Window);
        const { Tensor } = this.runtime;
        const feeds = { input_features: new Tensor('float32', features, [1, N_MELS, N_FRAMES]) };
        const results = await this.session.run(feeds);
        const first = Object.values(results)[0] as OnnxTensor | undefined;
        const data = first?.data as Float32Array | undefined;
        const probability = data?.[0] ?? 0;
        const finalProb = Math.min(1, Math.max(0, probability));
        span.setAttribute('patter.eos.score', finalProb);
        span.setAttribute('patter.onnx.inference_ms', Date.now() - startMs);
        return finalProb;
      } catch (err) {
        span.recordException(err as Error);
        throw err;
      } finally {
        try { span.end(); } catch { /* swallow */ }
      }
    }

    // 2. Dual-Gated Turn Detection (TurnSense Text Heuristics + Telnyx Wav2Vec2 EOS Audio Tie-Breaker)
    const textScore = await this.turnSense.predict(pcm16Window, transcript ?? '');

    // Fast-path: clear certainty
    if (textScore >= 0.75) return 1.0;
    if (textScore < 0.45) return 0.2;

    // Gray-Zone Uncertainty (0.45 <= textScore < 0.75) -> Run Telnyx Wav2Vec2 EOS 700ms audio tie-breaker!
    const eosScore = await this.telnyxEOS.predictEos(pcm16Window);
    if (eosScore >= this.telnyxEOS.threshold) {
      return 0.95;
    }

    return 0.35;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.turnSense.close();
    await this.telnyxEOS.close();
    this.session = null;
  }
}
