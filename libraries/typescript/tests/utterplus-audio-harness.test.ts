import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { TenVAD } from '../src/providers/ten-vad';
import { TurnSenseDetector } from '../src/providers/turn-sense';
import { generateAllPcmFixtures } from './helpers/pcm-fixture-generator';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Custom Audio Fixture Harness (Raw PCM WebSocket Frame Stream)', () => {
  let fixturePaths: Record<string, string>;

  beforeAll(() => {
    fixturePaths = generateAllPcmFixtures(FIXTURES_DIR);
  });

  it('Scenario 1 – Clean complete turn from raw WebSocket PCM stream', async () => {
    const rawPcm = fs.readFileSync(fixturePaths['scenario1']);
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.1 });
    const turnSense = await TurnSenseDetector.load();

    const events: string[] = [];
    // 20ms WebSocket PCM frame chunk @ 16kHz int16 = 640 bytes per WS message frame
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const wsFrameBuffer = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(wsFrameBuffer, 16000);
      if (vadEvt) {
        events.push(vadEvt.type);
      }
    }

    expect(events).toContain('speech_start');
    expect(events).toContain('speech_end');

    const score = await turnSense.predict(rawPcm, 'I would like to book an appointment for next Tuesday.');
    expect(score).toBeGreaterThanOrEqual(turnSense.threshold);
    events.push('policy_llm_called');

    expect(events).toEqual(['speech_start', 'speech_end', 'policy_llm_called']);

    await vad.close();
    await turnSense.close();
  });

  it('Scenario 2 – Thinking pause from raw WebSocket PCM stream', async () => {
    const rawPcm = fs.readFileSync(fixturePaths['scenario2']);
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.2 });
    const turnSense = await TurnSenseDetector.load();

    const events: string[] = [];
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const wsFrameBuffer = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(wsFrameBuffer, 16000);
      if (vadEvt?.type === 'speech_end') {
        events.push('speech_end_pause');
      }
    }

    const partialScore = await turnSense.predict(rawPcm, 'My account number is... uh...');
    expect(partialScore).toBeLessThan(turnSense.threshold);
    events.push('turnsense_incomplete_hold');

    const finalScore = await turnSense.predict(rawPcm, 'My account number is... uh... 4829.');
    expect(finalScore).toBeGreaterThanOrEqual(turnSense.threshold);
    events.push('turnsense_complete_dispatch');

    expect(events).toContain('turnsense_incomplete_hold');
    expect(events).toContain('turnsense_complete_dispatch');

    await vad.close();
    await turnSense.close();
  });

  it('Scenario 3 – True barge-in from raw WebSocket PCM stream', async () => {
    const rawPcm = fs.readFileSync(fixturePaths['scenario3']);
    const vad = await TenVAD.load({ minSpeechDuration: 0.1, bargeInThresholdMs: 150 });

    let bargeInFired = false;
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const wsFrameBuffer = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(wsFrameBuffer, 16000);
      if (vadEvt?.type === 'speech_start') {
        bargeInFired = true;
      }
    }

    expect(bargeInFired).toBe(true);
    await vad.close();
  });

  it('Scenario 4 – Backchannel / noise from raw WebSocket PCM stream', async () => {
    const rawPcm = fs.readFileSync(fixturePaths['scenario4']);
    const vad = await TenVAD.load({ minSpeechDuration: 0.25 });

    const events: string[] = [];
    const wsFrameSize = 640;

    for (let offset = 0; offset < rawPcm.length; offset += wsFrameSize) {
      const wsFrameBuffer = rawPcm.subarray(offset, offset + wsFrameSize);
      const vadEvt = await vad.processFrame(wsFrameBuffer, 16000);
      if (vadEvt) events.push(vadEvt.type);
    }

    expect(events).toEqual([]); // 80 ms cough ignored by threshold
    await vad.close();
  });

  it('Scenario 5 – Fast short answer from raw WebSocket PCM stream', async () => {
    const rawPcm = fs.readFileSync(fixturePaths['scenario5']);
    const turnSense = await TurnSenseDetector.load();

    const score = await turnSense.predict(rawPcm, 'Morning.');
    expect(score).toBeGreaterThanOrEqual(0.9);

    await turnSense.close();
  });
});
