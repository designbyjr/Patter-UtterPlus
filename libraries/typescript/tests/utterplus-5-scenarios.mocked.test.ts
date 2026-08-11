import { describe, it, expect } from 'vitest';
import { TenVAD } from '../src/providers/ten-vad';
import { TurnSenseDetector } from '../src/providers/turn-sense';
import { SyntheticAudioGenerator } from './helpers/audio-generator';

describe('UtterPlus 5 Conversation Scenarios Unit Suite', () => {
  const generator = new SyntheticAudioGenerator({ sampleRate: 16000 });

  it('Scenario 1 – Clean complete turn', async () => {
    const vad = await TenVAD.load({ minSpeechDuration: 0.05, minSilenceDuration: 0.05 });
    const detector = await TurnSenseDetector.load();
    const pcm = Buffer.alloc(512);

    // Audio arrives & speech start detected
    const loudFrame = generator.generateTone(32, 440, 0.9);
    let startEvent = null;
    for (let i = 0; i < 3; i++) {
      const evt = await vad.processFrame(loudFrame, 16000);
      if (evt?.type === 'speech_start') startEvent = evt;
    }
    expect(startEvent).not.toBeNull();

    // User stops speaking -> VAD silence
    const silenceFrame = generator.generateSilence(32);
    let endEvent = null;
    for (let i = 0; i < 3; i++) {
      const evt = await vad.processFrame(silenceFrame, 16000);
      if (evt?.type === 'speech_end') endEvent = evt;
    }
    expect(endEvent).not.toBeNull();

    // TurnSense completes turn
    const transcript = 'I would like to book an appointment for next Tuesday.';
    const score = await detector.predict(pcm, transcript);
    expect(score).toBeGreaterThanOrEqual(detector.threshold); // Complete -> Trigger LLM

    await vad.close();
    await detector.close();
  });

  it('Scenario 2 – Thinking pause (incomplete)', async () => {
    const detector = await TurnSenseDetector.load();
    const pcm = Buffer.alloc(512);

    // Partial 1: "My account number is... uh..."
    const partial1 = 'My account number is... uh...';
    const score1 = await detector.predict(pcm, partial1);
    expect(score1).toBeLessThan(detector.threshold); // Incomplete -> System holds LLM call

    // Partial 2: Speech continues: "My account number is... uh... 4829."
    const partial2 = 'My account number is... uh... 4829.';
    const score2 = await detector.predict(pcm, partial2);
    expect(score2).toBeGreaterThanOrEqual(detector.threshold); // Complete -> Only then LLM runs

    await detector.close();
  });

  it('Scenario 3 – True barge-in (sustained user voice interrupts TTS)', async () => {
    const vad = await TenVAD.load({ minSpeechDuration: 0.05, bargeInThresholdMs: 100 });

    // Sustained user speech arrives during agent TTS
    const loudTone = generator.generateTone(32, 440, 0.9);
    let speechStartCount = 0;
    for (let i = 0; i < 4; i++) {
      const evt = await vad.processFrame(loudTone, 16000);
      if (evt?.type === 'speech_start') speechStartCount++;
    }

    expect(speechStartCount).toBeGreaterThan(0); // Sustained voice triggers immediate cancel
    await vad.close();
  });

  it('Scenario 4 – Backchannel / noise below barge_in_threshold_ms ignored', async () => {
    const vad = await TenVAD.load({ minSpeechDuration: 0.25 }); // 250 ms threshold

    // Short noise/cough (32 ms < 250 ms threshold)
    const noiseFrame = generator.generateNoise(32, 0.4);
    const evt = await vad.processFrame(noiseFrame, 16000);

    expect(evt).toBeNull(); // Ignored -> Agent TTS continues uninterrupted
    await vad.close();
  });

  it('Scenario 5 – Fast complete short answer', async () => {
    const detector = await TurnSenseDetector.load();
    const pcm = Buffer.alloc(512);

    const transcript = 'Morning.';
    const score = await detector.predict(pcm, transcript);

    expect(score).toBeGreaterThanOrEqual(0.9); // High confidence on short definitive answer -> Fast LLM answer
    await detector.close();
  });
});
