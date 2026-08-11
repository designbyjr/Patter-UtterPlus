/**
 * speech-emotion.test.ts
 * Unit tests for SpeechEmotionDetector in src/providers/speech-emotion.ts.
 */

import { describe, it, expect } from 'vitest';
import { SpeechEmotionDetector } from '../src/providers/speech-emotion';

describe('SpeechEmotionDetector Unit Tests', () => {
  it('instantiates and provides heuristic prediction without ONNX model', async () => {
    const detector = await SpeechEmotionDetector.load();
    const silentPcm = new Float32Array(16000); // 1 second of silence
    const res = await detector.predict(silentPcm);

    expect(res).toBeDefined();
    expect(res.emotion).toBe('neutral');
    expect(res.score).toBeGreaterThan(0);
    expect(res.probabilities.neutral).toBeGreaterThan(0.5);
  });

  it('detects high energy audio in heuristic fallback', async () => {
    const detector = await SpeechEmotionDetector.load();
    const loudPcm = new Float32Array(16000);
    for (let i = 0; i < loudPcm.length; i++) loudPcm[i] = (Math.random() - 0.5) * 0.8;

    const res = await detector.predict(loudPcm);
    expect(res.emotion).toBe('angry');
    expect(res.score).toBeGreaterThan(0.5);
  });
});
