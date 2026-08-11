import { describe, it, expect } from 'vitest';
import { TenVAD } from '../../../src/providers/ten-vad';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 1: Single Speaker — Scenario 3 (True Barge-in)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts sustained user speech fires barge-in to stop TTS output', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 3, numSpeakers: 1, noiseLevelDbfs: -50 });
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, bargeInThresholdMs: 150 });

    let bargeInFired = false;
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const chunk = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(chunk, 16000);
      if (vadEvt?.type === 'speech_start') bargeInFired = true;
    }

    expect(bargeInFired).toBe(true);
    await vad.close();
  });
});
