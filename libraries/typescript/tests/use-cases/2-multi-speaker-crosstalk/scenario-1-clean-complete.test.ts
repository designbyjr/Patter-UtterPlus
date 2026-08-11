import { describe, it, expect } from 'vitest';
import { TenVAD } from '../../../src/providers/ten-vad';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';

describe('Use Case 2: Multi-Speaker Crosstalk — Scenario 1 (Clean Complete Turn)', () => {
  const simulator = new LivePhoneCallSimulator(16000);

  it('asserts clean turn completion despite 3 background crosstalk speakers', async () => {
    const rawPcm = simulator.generateCallStream({ scenario: 1, numSpeakers: 3, noiseLevelDbfs: -45 });
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.1 });
    const turnSense = await TurnSenseDetector.load();

    const events: string[] = [];
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const chunk = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(chunk, 16000);
      if (vadEvt) events.push(vadEvt.type);
    }
    const flushBuffer = Buffer.alloc(1024);
    for (let i = 0; i < 3; i++) {
      const flushEvt = await vad.processFrame(flushBuffer, 16000);
      if (flushEvt) events.push(flushEvt.type);
    }

    expect(events).toContain('speech_start');
    expect(events).toContain('speech_end');

    const score = await turnSense.predict(rawPcm, 'I would like to book an appointment for next Tuesday.');
    expect(score).toBeGreaterThanOrEqual(turnSense.threshold);

    await vad.close();
    await turnSense.close();
  });
});
