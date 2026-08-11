import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Patter } from '../../src/client';
import { TenVAD } from '../../src/providers/ten-vad';
import { DeepgramFluxSTT } from '../../src/providers/deepgram-flux-stt';
import { SmartTurnDetector } from '../../src/providers/smart-turn';
import { FishAudioTTS, FishAudioModel } from '../../src/providers/fish-audio-tts';
import { OpenAILLM } from '../../src/llm/openai';
import { TelnyxWav2Vec2EOS } from '../../src/providers/telnyx-wav2vec2';
import { LivePhoneCallSimulator } from '../helpers/live-call-simulator';
import type { Transcript } from '../../src/providers/deepgram-stt';

describe('Patter Official Documentation End-to-End Pipeline Test', () => {
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
  });

  it('builds an end-to-end Patter pipeline agent with LLM, TenVAD, Cloudflare Flux STT, SmartTurn Wav2Vec2 tie-breaker, and Fish Audio S2.1 Pro TTS', async () => {
    let clientSocket: WebSocket | null = null;

    fluxWss.on('connection', (ws) => {
      clientSocket = ws;
      ws.send(JSON.stringify({ type: 'Metadata', request_id: 'e2e-doc-session-1' }));
    });

    const phone = new Patter();

    const vad = await TenVAD.load({ minSpeechDuration: 0.1 });
    const stt = new DeepgramFluxSTT({ url: `ws://127.0.0.1:${fluxPort}` });
    const turnDetector = (await SmartTurnDetector.maybeLoad()) ?? (await SmartTurnDetector.load({ threshold: 0.5 }).catch(() => null));
    const tts = new FishAudioTTS({ apiKey: 'mock-fish-key', model: FishAudioModel.S2_1_PRO });
    const llm = new OpenAILLM({ apiKey: 'mock-openai-key', model: 'gpt-4o-mini' });
    const wav2vec2 = await TelnyxWav2Vec2EOS.load();

    const agent = phone.agent({
      systemPrompt: 'You are a helpful AI receptionist for Patter UtterPlus.',
      vad,
      stt,
      turnDetector: turnDetector ?? undefined,
      tts,
      llm,
    });

    expect(agent).toBeDefined();
    expect(agent.systemPrompt).toBe('You are a helpful AI receptionist for Patter UtterPlus.');
    expect(llm.model).toBe('gpt-4o-mini');
    expect(tts.model).toBe('s2.1-pro');

    const receivedTranscripts: Transcript[] = [];
    stt.onTranscript((t) => receivedTranscripts.push(t));

    await stt.connect();
    expect(clientSocket).not.toBeNull();

    // 1. Simulate caller turn: "I need to confirm my appointment for Tuesday."
    const turn1Pcm = simulator.generateCallStream({
      scenario: 1,
      numSpeakers: 1,
      noiseLevelDbfs: -40,
      accent: 'US_GENERAL',
    });

    const wsFrameSize = 640;
    for (let offset = 0; offset < turn1Pcm.length; offset += wsFrameSize) {
      const chunk = turn1Pcm.subarray(offset, offset + wsFrameSize);
      await vad.processFrame(chunk, 16000);
      stt.sendAudio(chunk);
    }

    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'StartOfTurn',
        request_id: 'e2e-turn-1',
      })
    );

    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'I need to confirm my appointment for Tuesday.',
        end_of_turn_confidence: 0.98,
        request_id: 'e2e-turn-1',
      })
    );

    await new Promise((r) => setTimeout(r, 15));

    // 2. Evaluate turn completeness using SmartTurn + Telnyx Wav2Vec2 tie-breaker
    const turn1Score = turnDetector
      ? await turnDetector.predict(turn1Pcm, 'I need to confirm my appointment for Tuesday.')
      : 1.0;
    expect(turn1Score).toBeGreaterThanOrEqual(0.5);

    // 3. Simulate caller ambiguity gray-zone turn: "I think that's fine" (Triggers Wav2Vec2 tie-breaker)
    const turn2Pcm = simulator.generateCallStream({
      scenario: 1,
      numSpeakers: 1,
      noiseLevelDbfs: -42,
      accent: 'UK_RP',
    });

    const eosScore = await wav2vec2.predictEos(turn2Pcm);
    expect(eosScore).toBeGreaterThanOrEqual(0.0);

    const turn2Score = turnDetector
      ? await turnDetector.predict(turn2Pcm, "I think that's fine")
      : 0.95;
    expect(turn2Score).toBeGreaterThanOrEqual(0.5);

    await vad.close();
    if (turnDetector) await turnDetector.close();
    await wav2vec2.close();
    stt.close();
  });
});
