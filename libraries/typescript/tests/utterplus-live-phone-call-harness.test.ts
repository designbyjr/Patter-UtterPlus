import { describe, it, expect } from 'vitest';
import { TenVAD } from '../src/providers/ten-vad';
import { TurnSenseDetector } from '../src/providers/turn-sense';
import { LivePhoneCallSimulator } from './helpers/live-call-simulator';
import type { WesternAccentProfile } from './helpers/audio-generator';

describe('Real Live Phone Call Simulation Harness (Multi-Speaker, Noisy Line, 12 Western Accents Matrix)', () => {
  const simulator = new LivePhoneCallSimulator(16000);
  const accents: WesternAccentProfile[] = [
    'US_GENERAL',
    'US_SOUTHERN',
    'US_NEW_YORK',
    'US_AAVE',
    'UK_RP',
    'UK_COCKNEY',
    'UK_SCOTTISH',
    'UK_IRISH',
    'UK_WELSH',
    'AUSTRALIAN',
    'NEW_ZEALAND',
    'CANADIAN',
  ];

  for (const accent of accents) {
    describe(`Western Accent Profile: ${accent}`, () => {
      it(`Scenario 1 – [${accent}] Clean complete turn`, async () => {
        const rawPcm = simulator.generateCallStream({
          scenario: 1,
          numSpeakers: 3,
          noiseLevelDbfs: -42,
          accent,
        });

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

      it(`Scenario 2 – [${accent}] Thinking pause`, async () => {
        const rawPcm = simulator.generateCallStream({
          scenario: 2,
          numSpeakers: 2,
          noiseLevelDbfs: -40,
          accent,
        });

        const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.2 });
        const turnSense = await TurnSenseDetector.load();

        const partialScore = await turnSense.predict(rawPcm, 'My account number is... uh...');
        expect(partialScore).toBeLessThan(turnSense.threshold);

        const finalScore = await turnSense.predict(rawPcm, 'My account number is... uh... 4829.');
        expect(finalScore).toBeGreaterThanOrEqual(turnSense.threshold);

        await vad.close();
        await turnSense.close();
      });

      it(`Scenario 3 – [${accent}] True barge-in`, async () => {
        const rawPcm = simulator.generateCallStream({
          scenario: 3,
          numSpeakers: 4,
          noiseLevelDbfs: -38,
          accent,
        });

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

      it(`Scenario 4 – [${accent}] Backchannel noise ignored`, async () => {
        const rawPcm = simulator.generateCallStream({
          scenario: 4,
          numSpeakers: 3,
          noiseLevelDbfs: -40,
          accent,
        });

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

      it(`Scenario 5 – [${accent}] Fast short answer`, async () => {
        const rawPcm = simulator.generateCallStream({
          scenario: 5,
          numSpeakers: 2,
          noiseLevelDbfs: -45,
          accent,
        });

        const turnSense = await TurnSenseDetector.load();
        const score = await turnSense.predict(rawPcm, 'Morning.');
        expect(score).toBeGreaterThanOrEqual(0.9);

        await turnSense.close();
      });
    });
  }
});
