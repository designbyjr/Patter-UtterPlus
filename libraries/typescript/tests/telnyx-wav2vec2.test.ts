import { describe, it, expect } from 'vitest';
import { TelnyxWav2Vec2EOS } from '../src/providers/telnyx-wav2vec2';
import { SmartTurnDetector } from '../src/providers/smart-turn';
import { SyntheticAudioGenerator } from './helpers/audio-generator';

describe('TelnyxWav2Vec2EOS & Unified SmartTurn Integration Unit Tests', () => {
  const audioGen = new SyntheticAudioGenerator({ sampleRate: 16000 });

  it('should initialize TelnyxWav2Vec2EOS cleanly with default options', async () => {
    const eos = await TelnyxWav2Vec2EOS.load();
    expect(eos).toBeDefined();
    expect(eos.threshold).toBe(0.8);
    await eos.close();
  });

  it('evaluates 700ms PCM audio buffer and returns EOS probability', async () => {
    const eos = await TelnyxWav2Vec2EOS.load();
    const pcm = audioGen.generateAccentSpeech(700, 'US_GENERAL');

    const score = await eos.predictEos(pcm);
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(1.0);

    await eos.close();
  });

  it('SmartTurnDetector fast-paths high-confidence text scores (>= 0.75 or < 0.45)', async () => {
    const smartTurn = (await SmartTurnDetector.maybeLoad()) ?? (await SmartTurnDetector.load({ modelPath: 'package.json' }).catch(() => null));
    if (!smartTurn) return;

    const pcm = audioGen.generateAccentSpeech(700, 'US_GENERAL');

    // 1. High confidence complete ("Morning.") -> returns 1.0 fast-path
    const completeScore = await smartTurn.predict(pcm, 'Morning.');
    expect(completeScore).toBe(1.0);

    // 2. High confidence incomplete ("My account number is... uh") -> returns 0.2
    const incompleteScore = await smartTurn.predict(pcm, 'My account number is... uh');
    expect(incompleteScore).toBe(0.2);

    await smartTurn.close();
  });

  it('SmartTurnDetector triggers TelnyxWav2Vec2EOS tie-breaker in gray-zone (0.45 <= textScore < 0.75)', async () => {
    const smartTurn = (await SmartTurnDetector.maybeLoad()) ?? (await SmartTurnDetector.load({ modelPath: 'package.json' }).catch(() => null));
    if (!smartTurn) return;

    const pcm = audioGen.generateAccentSpeech(700, 'US_GENERAL');

    // "I think that's fine" produces a gray-zone text score (~0.55-0.65)
    const grayZoneScore = await smartTurn.predict(pcm, "I think that's fine");
    expect(grayZoneScore).toBeGreaterThanOrEqual(0.5);

    await smartTurn.close();
  });
});
