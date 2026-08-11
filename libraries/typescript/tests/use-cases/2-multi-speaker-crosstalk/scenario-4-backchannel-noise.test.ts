import { describe, it, expect } from 'vitest';
import { TenVAD } from '../../../src/providers/ten-vad';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 2: Multi-Speaker Crosstalk — Scenario 4 (Backchannel Noise / Cough)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts short crosstalk cough does not trigger false barge-in', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 4, numSpeakers: 3, noiseLevelDbfs: -40 });
    const vad = await TenVAD.load({ minSpeechDuration: 0.25 });

    const events: string[] = [];
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const chunk = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(chunk, 16000);
      if (vadEvt) events.push(vadEvt.type);
    }

    expect(events).toEqual([]);
    await vad.close();
  });
});
