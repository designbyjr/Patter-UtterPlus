import { describe, it, expect } from 'vitest';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 3: Noisy Line PSTN — Scenario 5 (Fast Short Answer)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts fast short answer ("Morning.") gets high score on noisy PSTN line', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 5, numSpeakers: 1, noiseLevelDbfs: -38 });
    const turnSense = await TurnSenseDetector.load();

    const score = await turnSense.predict(rawPcm, 'Morning.');
    expect(score).toBeGreaterThanOrEqual(0.9);

    await turnSense.close();
  });
});
