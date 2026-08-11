import { describe, it, expect } from 'vitest';
import { TenVAD } from '../../../src/providers/ten-vad';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 1: Single Speaker — Scenario 4 (Backchannel Noise / Cough)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts short noise burst below threshold is ignored (no barge-in / TTS continues)', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 4, numSpeakers: 1, noiseLevelDbfs: -50 });
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
