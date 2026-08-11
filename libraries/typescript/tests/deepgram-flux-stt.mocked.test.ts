import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { DeepgramFluxSTT } from '../src/providers/deepgram-flux-stt';
import type { Transcript } from '../src/providers/deepgram-stt';

describe('DeepgramFluxSTT WebSocket Unit Tests', () => {
  let wss: WebSocketServer;
  let serverPort: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address();
        serverPort = typeof addr === 'object' && addr !== null ? addr.port : 8080;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('should connect and handle Cloudflare Flux TurnInfo events', async () => {
    let clientSocket: WebSocket | null = null;

    wss.on('connection', (ws) => {
      clientSocket = ws;
      ws.send(JSON.stringify({ type: 'Metadata', request_id: 'flux-req-123' }));
    });

    const fluxStt = new DeepgramFluxSTT({
      url: `ws://127.0.0.1:${serverPort}`,
    });

    const receivedTranscripts: Array<Transcript & { fluxEvent?: string }> = [];
    fluxStt.onTranscript((t) => receivedTranscripts.push(t));

    await fluxStt.connect();
    expect(clientSocket).not.toBeNull();

    // 1. Simulate StartOfTurn
    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'StartOfTurn',
        request_id: 'flux-req-123',
      })
    );

    // 2. Simulate Update
    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'Update',
        transcript: 'I would like to book',
        request_id: 'flux-req-123',
      })
    );

    // 3. Simulate EagerEndOfTurn
    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'EagerEndOfTurn',
        transcript: 'I would like to book an appointment',
        end_of_turn_confidence: 0.85,
        request_id: 'flux-req-123',
      })
    );

    // 4. Simulate EndOfTurn
    clientSocket!.send(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'I would like to book an appointment.',
        end_of_turn_confidence: 0.98,
        request_id: 'flux-req-123',
      })
    );

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(receivedTranscripts.length).toBe(4);
    expect(receivedTranscripts[0].fluxEvent).toBe('StartOfTurn');
    expect(receivedTranscripts[1].fluxEvent).toBe('Update');
    expect(receivedTranscripts[1].text).toBe('I would like to book');
    expect(receivedTranscripts[2].fluxEvent).toBe('EagerEndOfTurn');
    expect(receivedTranscripts[3].fluxEvent).toBe('EndOfTurn');
    expect(receivedTranscripts[3].text).toBe('I would like to book an appointment.');

    fluxStt.close();
  });
});
