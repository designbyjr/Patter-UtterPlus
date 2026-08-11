import { SyntheticAudioGenerator, WesternAccentProfile } from './audio-generator';

export interface PhoneCallSimulationOptions {
  readonly numSpeakers?: number; // 1 to 4 speakers
  readonly noiseLevelDbfs?: number; // Background noise level in dBFS (e.g. -45 dBFS to -40 dBFS)
  readonly scenario: 1 | 2 | 3 | 4 | 5;
  readonly accent?: WesternAccentProfile; // 12 Western English accents
  readonly sampleRate?: number;
}

export class LivePhoneCallSimulator {
  private readonly generator: SyntheticAudioGenerator;
  private readonly sampleRate: number;

  constructor(sampleRate: number = 16000) {
    this.sampleRate = sampleRate;
    this.generator = new SyntheticAudioGenerator({ sampleRate });
  }

  /**
   * Generates a realistic multi-speaker, noisy PSTN call audio stream with randomized timing & Western accent parameters.
   */
  generateCallStream(options: PhoneCallSimulationOptions): Buffer {
    const numSpeakers = Math.min(4, Math.max(1, options.numSpeakers ?? 1));
    const noiseLevel = options.noiseLevelDbfs ?? -42;
    const scenario = options.scenario;
    const accent = options.accent ?? 'US_GENERAL';

    const createBackgroundNoise = (durationMs: number): Buffer => {
      const amp = Math.pow(10, noiseLevel / 20);
      return this.generator.generateNoise(durationMs, amp);
    };

    const mixBuffers = (speechBuf: Buffer, noiseBuf: Buffer): Buffer => {
      const minLength = Math.min(speechBuf.length, noiseBuf.length);
      const out = Buffer.alloc(minLength);
      const numSamples = Math.floor(minLength / 2);

      for (let i = 0; i < numSamples; i++) {
        const s = speechBuf.readInt16LE(i * 2);
        const n = noiseBuf.readInt16LE(i * 2);
        const mixed = Math.max(-32768, Math.min(32767, s + n));
        out.writeInt16LE(mixed, i * 2);
      }
      return out;
    };

    const generateSecondaryCrosstalk = (durationMs: number, targetByteLength: number): Buffer => {
      if (numSpeakers <= 1) return this.generator.generateSilence(durationMs).subarray(0, targetByteLength);

      let crosstalk = Buffer.alloc(targetByteLength);
      for (let s = 2; s <= numSpeakers; s++) {
        const rawSecondary = this.generator.generateAccentSpeech(durationMs, 'UK_RP', 0.005);
        const secondaryTone = rawSecondary.subarray(0, targetByteLength);
        const temp = Buffer.alloc(targetByteLength);
        const maxSamples = Math.min(Math.floor(crosstalk.length / 2), Math.floor(secondaryTone.length / 2));
        for (let i = 0; i < maxSamples; i++) {
          const v1 = crosstalk.readInt16LE(i * 2);
          const v2 = secondaryTone.readInt16LE(i * 2);
          temp.writeInt16LE(Math.max(-32768, Math.min(32767, v1 + v2)), i * 2);
        }
        crosstalk = temp;
      }
      return crosstalk;
    };

    let pcmStream: Buffer;

    switch (scenario) {
      case 1: {
        const speechMs = 600 + Math.floor(Math.random() * 200);
        const silenceMs = 800 + Math.floor(Math.random() * 200);
        const primarySpeech = this.generator.generateAccentSpeech(speechMs, accent, 0.85);
        const silencePad = this.generator.generateSilence(silenceMs);
        const totalDurationMs = speechMs + silenceMs;

        const rawSpeech = Buffer.concat([primarySpeech, silencePad]);
        const bgNoise = createBackgroundNoise(totalDurationMs).subarray(0, rawSpeech.length);
        const crosstalk = generateSecondaryCrosstalk(totalDurationMs, rawSpeech.length);

        pcmStream = mixBuffers(mixBuffers(rawSpeech, bgNoise), crosstalk);
        break;
      }

      case 2: {
        const utterance1Ms = 400 + Math.floor(Math.random() * 150);
        const pauseMs = 800 + Math.floor(Math.random() * 600);
        const utterance2Ms = 400 + Math.floor(Math.random() * 150);
        const finalSilenceMs = 800;

        const u1 = this.generator.generateAccentSpeech(utterance1Ms, accent, 0.8);
        const pause = this.generator.generateSilence(pauseMs);
        const u2 = this.generator.generateAccentSpeech(utterance2Ms, accent, 0.8);
        const endSilence = this.generator.generateSilence(finalSilenceMs);

        const totalDurationMs = utterance1Ms + pauseMs + utterance2Ms + finalSilenceMs;
        const rawSpeech = Buffer.concat([u1, pause, u2, endSilence]);
        const bgNoise = createBackgroundNoise(totalDurationMs).subarray(0, rawSpeech.length);
        const crosstalk = generateSecondaryCrosstalk(totalDurationMs, rawSpeech.length);

        pcmStream = mixBuffers(mixBuffers(rawSpeech, bgNoise), crosstalk);
        break;
      }

      case 3: {
        const agentSpeechLeadInMs = 1000 + Math.floor(Math.random() * 400);
        const userInterruptionMs = 600 + Math.floor(Math.random() * 200);

        const leadIn = this.generator.generateSilence(agentSpeechLeadInMs);
        const userBargeIn = this.generator.generateAccentSpeech(userInterruptionMs, accent, 0.9);

        const totalDurationMs = agentSpeechLeadInMs + userInterruptionMs;
        const rawSpeech = Buffer.concat([leadIn, userBargeIn]);
        const bgNoise = createBackgroundNoise(totalDurationMs).subarray(0, rawSpeech.length);
        const crosstalk = generateSecondaryCrosstalk(totalDurationMs, rawSpeech.length);

        pcmStream = mixBuffers(mixBuffers(rawSpeech, bgNoise), crosstalk);
        break;
      }

      case 4: {
        const coughDurationMs = 50 + Math.floor(Math.random() * 30);
        const leadInMs = 300;
        const tailMs = 400;

        const leadIn = this.generator.generateSilence(leadInMs);
        const cough = this.generator.generateNoise(coughDurationMs, 0.2);
        const tail = this.generator.generateSilence(tailMs);

        const totalDurationMs = leadInMs + coughDurationMs + tailMs;
        const rawSpeech = Buffer.concat([leadIn, cough, tail]);
        const bgNoise = createBackgroundNoise(totalDurationMs).subarray(0, rawSpeech.length);
        const crosstalk = generateSecondaryCrosstalk(totalDurationMs, rawSpeech.length);

        pcmStream = mixBuffers(mixBuffers(rawSpeech, bgNoise), crosstalk);
        break;
      }

      case 5: {
        const shortSpeechMs = 150 + Math.floor(Math.random() * 150);
        const silenceMs = 600;

        const shortSpeech = this.generator.generateAccentSpeech(shortSpeechMs, accent, 0.85);
        const silencePad = this.generator.generateSilence(silenceMs);

        const totalDurationMs = shortSpeechMs + silenceMs;
        const rawSpeech = Buffer.concat([shortSpeech, silencePad]);
        const bgNoise = createBackgroundNoise(totalDurationMs).subarray(0, rawSpeech.length);
        const crosstalk = generateSecondaryCrosstalk(totalDurationMs, rawSpeech.length);

        pcmStream = mixBuffers(mixBuffers(rawSpeech, bgNoise), crosstalk);
        break;
      }

      default:
        throw new Error(`Unsupported scenario: ${scenario}`);
    }

    return pcmStream;
  }

  /**
   * Generates a randomized sequence of multi-turn scenario audio streams.
   */
  generateRandomizedMultiTurnCall(scenarios: Array<1 | 2 | 3 | 4 | 5>, accent: WesternAccentProfile = 'US_GENERAL'): Buffer {
    const buffers: Buffer[] = [];
    for (const scenario of scenarios) {
      buffers.push(this.generateCallStream({ scenario, accent, numSpeakers: Math.floor(Math.random() * 3) + 1 }));
    }
    return Buffer.concat(buffers);
  }
}
