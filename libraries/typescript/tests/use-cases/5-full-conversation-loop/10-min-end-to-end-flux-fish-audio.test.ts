import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { TenVAD } from '../../../src/providers/ten-vad';
import { TurnSenseDetector } from '../../../src/providers/turn-sense';
import { DeepgramFluxSTT } from '../../../src/providers/deepgram-flux-stt';
import { FishAudioTTS, FishAudioModel } from '../../../src/providers/fish-audio-tts';
import { LivePhoneCallSimulator } from '../../helpers/live-call-simulator';
import type { Transcript } from '../../../src/providers/deepgram-stt';

describe('Use Case 5: 10-Minute Full Conversation Loop (Cloudflare Flux STT + Fish Audio S2.1 Pro TTS)', () => {
  let fluxWss: WebSocketServer;
  let fluxPort: number;
  const simulator = new LivePhoneCallSimulator(16000);

  beforeEach(async () => {
    fluxWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      fluxWss.on('listening', () => {
        const addr = fluxWss.address();
        fluxPort = typeof addr === 'object' && addr !== null ? addr.port : 8080;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fluxWss.close(() => resolve()));
  }, 30000);

  it(
    'simulates a 10-minute call with 25 dynamic conversation turns using Cloudflare Flux & Fish Audio S2.1 Pro',
    async () => {
      let clientSocket: WebSocket | null = null;

      fluxWss.on('connection', (ws) => {
        clientSocket = ws;
        ws.send(JSON.stringify({ type: 'Metadata', request_id: 'cf-flux-session-10min' }));
      });

      const fluxStt = new DeepgramFluxSTT({
        url: `ws://127.0.0.1:${fluxPort}`,
      });

      const receivedFluxEvents: Array<Transcript & { fluxEvent?: string }> = [];
      fluxStt.onTranscript((t) => receivedFluxEvents.push(t));

      await fluxStt.connect();
      expect(clientSocket).not.toBeNull();

      const vad = await TenVAD.load({ minSpeechDuration: 0.1, minSilenceDuration: 0.1 });
      const turnSense = await TurnSenseDetector.load();
      const fishTts = new FishAudioTTS({ apiKey: 'mock-fish-key', model: FishAudioModel.S2_1_PRO });

      expect(fishTts.model).toBe('s2.1-pro');

      const conversationTurns = [
        { userText: 'Hello, I need help with my account.', expectedComplete: true },
        { userText: 'My account number is... uh', expectedComplete: false },
        { userText: 'My account number is... uh... 4829.', expectedComplete: true },
        { userText: 'Can you check my balance for Tuesday?', expectedComplete: true },
        { userText: 'Yes.', expectedComplete: true },
        { userText: 'And what about my pending transfer?', expectedComplete: true },
        { userText: 'Wait, let me think... uh', expectedComplete: false },
        { userText: 'Let me think... it was five hundred dollars.', expectedComplete: true },
        { userText: 'Morning.', expectedComplete: true },
        { userText: 'Could you email me the receipt?', expectedComplete: true },
        { userText: 'Thanks.', expectedComplete: true },
        { userText: 'Wait, stop right there!', expectedComplete: true, isBargeIn: true },
        { userText: 'I meant the checking account, not savings.', expectedComplete: true },
        { userText: 'Okay.', expectedComplete: true },
        { userText: 'Is there any fee for this transfer?', expectedComplete: true },
        { userText: 'No.', expectedComplete: true },
        { userText: 'What is the reference code?', expectedComplete: true },
        { userText: 'Understood.', expectedComplete: true },
        { userText: 'Can I change my registered phone number?', expectedComplete: true },
        { userText: 'The new number is... um', expectedComplete: false },
        { userText: 'The new number is 555-0199.', expectedComplete: true },
        { userText: 'Perfect.', expectedComplete: true },
        { userText: 'That will be all for today.', expectedComplete: true },
        { userText: 'Thank you for your help.', expectedComplete: true },
        { userText: 'Goodbye.', expectedComplete: true },
      ];

      let turnsProcessed = 0;
      let bargeInCancellations = 0;

      for (let turnIdx = 0; turnIdx < conversationTurns.length; turnIdx++) {
        const turn = conversationTurns[turnIdx];
        const scenarioType = turn.isBargeIn ? 3 : turn.expectedComplete ? 1 : 2;

        const turnPcm = simulator.generateCallStream({
          scenario: scenarioType,
          numSpeakers: 2,
          noiseLevelDbfs: -40,
          accent: turnIdx % 2 === 0 ? 'US_GENERAL' : 'UK_RP',
        });

        const wsFrameSize = 640;
        for (let offset = 0; offset < turnPcm.length; offset += wsFrameSize) {
          const chunk = turnPcm.subarray(offset, offset + wsFrameSize);
          await vad.processFrame(chunk, 16000);
          fluxStt.sendAudio(chunk);
        }

        clientSocket!.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'StartOfTurn',
            request_id: `cf-flux-turn-${turnIdx}`,
          })
        );

        clientSocket!.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'Update',
            transcript: turn.userText.split(' ')[0] ?? '',
            request_id: `cf-flux-turn-${turnIdx}`,
          })
        );

        if (turn.expectedComplete) {
          clientSocket!.send(
            JSON.stringify({
              type: 'TurnInfo',
              event: 'EndOfTurn',
              transcript: turn.userText,
              end_of_turn_confidence: 0.96,
              request_id: `cf-flux-turn-${turnIdx}`,
            })
          );
        } else {
          clientSocket!.send(
            JSON.stringify({
              type: 'TurnInfo',
              event: 'EagerEndOfTurn',
              transcript: turn.userText,
              end_of_turn_confidence: 0.35,
              request_id: `cf-flux-turn-${turnIdx}`,
            })
          );
        }

        // Allow WebSocket message ticks to drain into client handlers
        await new Promise((r) => setTimeout(r, 10));

        const score = await turnSense.predict(turnPcm, turn.userText);

        if (turn.expectedComplete) {
          expect(score).toBeGreaterThanOrEqual(turnSense.threshold);
          expect(fishTts.model).toBe('s2.1-pro');
        } else {
          expect(score).toBeLessThan(turnSense.threshold);
        }

        if (turn.isBargeIn) {
          bargeInCancellations++;
        }

        turnsProcessed++;
      }

      expect(turnsProcessed).toBe(25);
      expect(bargeInCancellations).toBe(1);
      expect(receivedFluxEvents.length).toBeGreaterThanOrEqual(50);

      await vad.close();
      await turnSense.close();
      fluxStt.close();
    },
    40000
  );
});
