import { describe, it, expect } from 'vitest';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 1: Single Speaker — Scenario 5 (Fast Short Answer)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts quick definitive answer ("Morning.") gets high confidence score immediately', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 5, numSpeakers: 1, noiseLevelDbfs: -50 });
    const turnSense = await TurnSenseDetector.load();

    const score = await turnSense.predict(rawPcm, 'Morning.');
    expect(score).toBeGreaterThanOrEqual(0.9);

    await turnSense.close();
  });
});
