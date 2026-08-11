import { describe, it, expect } from 'vitest';
import { TurnSenseDetector } from '../src/providers/turn-sense';

describe('TurnSenseDetector Unit Tests', () => {
  it('should score fast short answers as high confidence complete', async () => {
    const detector = await TurnSenseDetector.load();
    const dummyPcm = Buffer.alloc(100);

    const scoreMorning = await detector.predict(dummyPcm, 'Morning.');
    const scoreYes = await detector.predict(dummyPcm, 'Yes');

    expect(scoreMorning).toBeGreaterThanOrEqual(0.9);
    expect(scoreYes).toBeGreaterThanOrEqual(0.9);
    await detector.close();
  });

  it('should score thinking pauses as incomplete', async () => {
    const detector = await TurnSenseDetector.load();
    const dummyPcm = Buffer.alloc(100);

    const scoreIncomplete = await detector.predict(dummyPcm, 'My account number is...');
    const scoreUh = await detector.predict(dummyPcm, 'My account number is... uh...');

    expect(scoreIncomplete).toBeLessThan(0.5);
    expect(scoreUh).toBeLessThan(0.5);
    await detector.close();
  });

  it('should score complete sentences with period as complete', async () => {
    const detector = await TurnSenseDetector.load();
    const dummyPcm = Buffer.alloc(100);

    const score = await detector.predict(dummyPcm, 'I would like to book an appointment for next Tuesday.');
    expect(score).toBeGreaterThanOrEqual(0.85);
    await detector.close();
  });
});
