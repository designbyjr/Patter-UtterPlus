import { describe, it, expect, beforeEach } from 'vitest';
import { TenVAD } from '../src/providers/ten-vad';
import { SyntheticAudioGenerator } from './helpers/audio-generator';

describe('TenVAD Unit Tests', () => {
  let generator: SyntheticAudioGenerator;

  beforeEach(() => {
    generator = new SyntheticAudioGenerator({ sampleRate: 16000 });
  });

  it('should initialize cleanly with default options', async () => {
    const vad = await TenVAD.load();
    expect(vad.numFramesRequired()).toBe(512);
    await vad.close();
  });

  it('should report silence for zeroed audio buffers', async () => {
    const vad = await TenVAD.load();
    const silenceChunk = generator.generateSilence(32); // 32 ms frame (512 samples)
    const event = await vad.processFrame(silenceChunk, 16000);
    expect(event).toBeNull();
    await vad.close();
  });

  it('should detect speech start on loud sustained audio', async () => {
    const vad = await TenVAD.load({ minSpeechDuration: 0.05, activationThreshold: 0.5 });
    const loudTone = generator.generateTone(32, 440, 0.9); // 32 ms

    let detectedEvent = null;
    for (let i = 0; i < 4; i++) {
      const evt = await vad.processFrame(loudTone, 16000);
      if (evt) detectedEvent = evt;
    }

    expect(detectedEvent).not.toBeNull();
    expect(detectedEvent?.type).toBe('speech_start');
    await vad.close();
  });

  it('should reset per-utterance state when reset() is called', async () => {
    const vad = await TenVAD.load({ minSpeechDuration: 0.05, activationThreshold: 0.5 });
    const loudTone = generator.generateTone(32, 440, 0.9);

    await vad.processFrame(loudTone, 16000);
    await vad.processFrame(loudTone, 16000);
    vad.reset();

    const silence = generator.generateSilence(32);
    const event = await vad.processFrame(silence, 16000);
    expect(event).toBeNull();
    await vad.close();
  });
});
