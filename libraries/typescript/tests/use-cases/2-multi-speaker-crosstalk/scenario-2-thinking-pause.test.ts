import { describe, it, expect } from 'vitest';
import { TenVAD } from '../../../src/providers/ten-vad';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 2: Multi-Speaker Crosstalk — Scenario 2 (Thinking Pause)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts thinking pause holds open turn even with multi-speaker background babble', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 2, numSpeakers: 4, noiseLevelDbfs: -45 });
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.2 });
    const turnSense = await TurnSenseDetector.load();

    const partialScore = await turnSense.predict(rawPcm, 'My account number is... uh...');
    expect(partialScore).toBeLessThan(turnSense.threshold);

    const finalScore = await turnSense.predict(rawPcm, 'My account number is... uh... 4829.');
    expect(finalScore).toBeGreaterThanOrEqual(turnSense.threshold);

    await vad.close();
    await turnSense.close();
  });
});
