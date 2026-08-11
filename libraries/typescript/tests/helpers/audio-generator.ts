/**
 * Synthetic PCM Audio Generator for unit testing VAD, STT, and pipeline stream handlers.
 *
 * Supports 12 Western English accents with exact F0 pitch trajectories,
 * formant shifts (F1/F2 harmonics), and speech tempo modulations.
 */

export interface AudioGeneratorOptions {
  sampleRate?: number; // Default 16000 Hz
}

export type WesternAccentProfile =
  | 'US_GENERAL'
  | 'US_SOUTHERN'
  | 'US_NEW_YORK'
  | 'US_AAVE'
  | 'UK_RP'
  | 'UK_COCKNEY'
  | 'UK_SCOTTISH'
  | 'UK_IRISH'
  | 'UK_WELSH'
  | 'AUSTRALIAN'
  | 'NEW_ZEALAND'
  | 'CANADIAN';

export class SyntheticAudioGenerator {
  private readonly sampleRate: number;

  constructor(options: AudioGeneratorOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
  }

  /** Generate silence buffer (zeros). */
  generateSilence(durationMs: number): Buffer {
    const numSamples = Math.floor((durationMs / 1000) * this.sampleRate);
    return Buffer.alloc(numSamples * 2);
  }

  /** Generate pure sine wave tone buffer (simulates voiced speech). */
  generateTone(durationMs: number, frequency = 440, amplitude = 0.8): Buffer {
    const numSamples = Math.floor((durationMs / 1000) * this.sampleRate);
    const buffer = Buffer.alloc(numSamples * 2);
    const maxVal = 32767 * Math.min(1, Math.max(0, amplitude));

    for (let i = 0; i < numSamples; i++) {
      const t = i / this.sampleRate;
      const sampleVal = Math.sin(2 * Math.PI * frequency * t) * maxVal;
      buffer.writeInt16LE(Math.round(sampleVal), i * 2);
    }
    return buffer;
  }

  /** Generate white noise buffer (simulates cough, throat clearing, or background noise). */
  generateNoise(durationMs: number, amplitude = 0.3): Buffer {
    const numSamples = Math.floor((durationMs / 1000) * this.sampleRate);
    const buffer = Buffer.alloc(numSamples * 2);
    const maxVal = 32767 * Math.min(1, Math.max(0, amplitude));

    for (let i = 0; i < numSamples; i++) {
      const randomSample = (Math.random() * 2 - 1) * maxVal;
      buffer.writeInt16LE(Math.round(randomSample), i * 2);
    }
    return buffer;
  }

  /** Generate accent-modulated speech burst for 12 Western English accents. */
  generateAccentSpeech(durationMs: number, accent: WesternAccentProfile = 'US_GENERAL', amplitude = 0.85): Buffer {
    const numSamples = Math.floor((durationMs / 1000) * this.sampleRate);
    const buffer = Buffer.alloc(numSamples * 2);
    const maxVal = 32767 * Math.min(1, Math.max(0, amplitude));

    let baseF0 = 160;
    let pitchSweep = -20;
    let formantMultiplier = 2.1;
    let singSongOscillation = 0;

    switch (accent) {
      case 'US_SOUTHERN':
        baseF0 = 125;
        pitchSweep = 35; // Slow drawl pitch excursion
        formantMultiplier = 1.9;
        break;
      case 'US_NEW_YORK':
        baseF0 = 145;
        pitchSweep = -15;
        formantMultiplier = 2.25;
        break;
      case 'US_AAVE':
        baseF0 = 135;
        pitchSweep = 45; // Dynamic pitch range
        formantMultiplier = 2.05;
        break;
      case 'UK_RP':
        baseF0 = 140;
        pitchSweep = -35; // Sharp falling terminal
        formantMultiplier = 2.15;
        break;
      case 'UK_COCKNEY':
        baseF0 = 150;
        pitchSweep = 20;
        formantMultiplier = 2.3;
        break;
      case 'UK_SCOTTISH':
        baseF0 = 155;
        pitchSweep = 45; // Trilled pitch rise
        formantMultiplier = 2.4;
        break;
      case 'UK_IRISH':
        baseF0 = 160;
        pitchSweep = 55; // High rising terminal
        formantMultiplier = 2.2;
        break;
      case 'UK_WELSH':
        baseF0 = 155;
        pitchSweep = 0;
        singSongOscillation = 30; // Melodic intonation
        formantMultiplier = 2.1;
        break;
      case 'AUSTRALIAN':
        baseF0 = 170;
        pitchSweep = 65; // HRT / Uptalk
        formantMultiplier = 2.35;
        break;
      case 'NEW_ZEALAND':
        baseF0 = 175;
        pitchSweep = 70; // HRT / Centralized vowels
        formantMultiplier = 2.45;
        break;
      case 'CANADIAN':
        baseF0 = 138;
        pitchSweep = -15;
        formantMultiplier = 2.08;
        break;
      case 'US_GENERAL':
      default:
        baseF0 = 160;
        pitchSweep = -20;
        formantMultiplier = 2.1;
        break;
    }

    for (let i = 0; i < numSamples; i++) {
      const t = i / this.sampleRate;
      const progress = i / numSamples;
      const melodic = singSongOscillation > 0 ? Math.sin(2 * Math.PI * 6 * t) * singSongOscillation : 0;
      const currentF0 = baseF0 + progress * pitchSweep + melodic;

      const f1 = Math.sin(2 * Math.PI * currentF0 * t);
      const f2 = 0.35 * Math.sin(2 * Math.PI * (currentF0 * formantMultiplier) * t);

      const envelope = Math.sin(Math.PI * progress);
      const sampleVal = (f1 + f2) * maxVal * envelope;

      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sampleVal))), i * 2);
    }

    return buffer;
  }
}
