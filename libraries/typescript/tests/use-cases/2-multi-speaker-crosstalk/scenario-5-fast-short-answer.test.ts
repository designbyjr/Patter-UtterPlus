import { describe, it, expect } from 'vitest';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 2: Multi-Speaker Crosstalk — Scenario 5 (Fast Short Answer)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts fast short answer ("Morning.") gets high score despite crosstalk', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 5, numSpeakers: 3, noiseLevelDbfs: -40 });
    const turnSense = await TurnSenseDetector.load();

    const score = await turnSense.predict(rawPcm, 'Morning.');
    expect(score).toBeGreaterThanOrEqual(0.9);

    await turnSense.close();
  });
});
