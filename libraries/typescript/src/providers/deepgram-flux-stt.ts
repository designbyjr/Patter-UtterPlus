/**
 * Deepgram Flux Streaming STT Adapter for Cloudflare Workers AI & Deepgram Flux WebSocket endpoint.
 *
 * Connects via WebSocket to streaming `@cf/deepgram/flux` or custom Cloudflare proxy endpoints,
 * parsing `TurnInfo` messages and mapping `StartOfTurn`, `Update`, `EagerEndOfTurn`,
 * `TurnResumed`, and `EndOfTurn` events into Patter-normalized {@link Transcript} objects.
 */

import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { AuthenticationError, PatterConnectionError, RateLimitError } from '../errors';
import { getLogger } from '../logger';
import type { Transcript, DeepgramWord } from './deepgram-stt';

export type FluxEventType = 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';

export interface FluxTurnInfoMessage {
  readonly type: 'TurnInfo' | 'Metadata';
  readonly request_id?: string;
  readonly sequence_id?: number;
  readonly event?: FluxEventType;
  readonly turn_index?: number;
  readonly audio_window_start?: number;
  readonly audio_window_end?: number;
  readonly transcript?: string;
  readonly words?: ReadonlyArray<DeepgramWord>;
  readonly end_of_turn_confidence?: number;
}

export interface DeepgramFluxSTTOptions {
  readonly apiKey?: string;
  readonly url?: string; // WebSocket URL (e.g. wss://api.deepgram.com/v1/listen or Cloudflare Worker URL)
  readonly model?: string; // Default "@cf/deepgram/flux" or "flux-general-en"
  readonly language?: string; // Default "en"
  readonly sampleRate?: number; // Default 16000 Hz
  readonly encoding?: string; // Default "linear16"
}

type TranscriptCallback = (transcript: Transcript & { fluxEvent?: FluxEventType; endOfTurnConfidence?: number }) => void;
type ErrorCallback = (error: Error) => void;

export class DeepgramFluxSTT {
  static readonly providerKey = 'deepgram_flux';
  private ws: WebSocket | null = null;
  private readonly transcriptCallbacks = new Set<TranscriptCallback>();
  private readonly errorCallbacks = new Set<ErrorCallback>();
  private running = false;
  private requestId = '';
  private readonly ctorOptions: DeepgramFluxSTTOptions;

  get isRunning(): boolean {
    return this.running;
  }

  constructor(options: DeepgramFluxSTTOptions = {}) {
    this.ctorOptions = options;
  }

  clone(): this {
    const ctor = this.constructor as new (opts: DeepgramFluxSTTOptions) => this;
    return new ctor(this.ctorOptions);
  }

  async connect(): Promise<void> {
    const url = this.ctorOptions.url ?? 'wss://api.deepgram.com/v1/listen?model=flux-general-en&encoding=linear16&sample_rate=16000';
    const apiKey = this.ctorOptions.apiKey ?? process.env.DEEPGRAM_API_KEY ?? '';

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Token ${apiKey}`;
    }

    const ws = new WebSocket(url, { headers });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new PatterConnectionError('Deepgram Flux WebSocket connect timeout'));
        }
      }, 10000);

      ws.once('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });

      ws.once('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      ws.once('unexpected-response', (_req: unknown, res: IncomingMessage) => {
        const status = res?.statusCode ?? 0;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (status === 401 || status === 403) {
            reject(new AuthenticationError(`Deepgram Flux rejected API key (HTTP ${status})`));
          } else if (status === 429) {
            reject(new RateLimitError(`Deepgram Flux rate limit exceeded (HTTP ${status})`));
          } else {
            reject(new PatterConnectionError(`Deepgram Flux WebSocket upgrade failed (HTTP ${status})`));
          }
        }
      });
    });

    this.running = true;
    ws.on('message', (data) => this.handleMessage(data.toString()));
    ws.on('close', () => {
      this.running = false;
    });
    ws.on('error', (err) => {
      this.emitError(err);
    });
  }

  handleMessage(raw: string): void {
    let msg: FluxTurnInfoMessage;
    try {
      msg = JSON.parse(raw) as FluxTurnInfoMessage;
    } catch {
      return;
    }

    if (msg.type === 'Metadata' && msg.request_id) {
      this.requestId = msg.request_id;
      return;
    }

    if (msg.type !== 'TurnInfo' && !msg.event) return;

    const event = msg.event;
    const text = (msg.transcript ?? '').trim();
    const requestId = msg.request_id ?? this.requestId;
    const endOfTurnConfidence = msg.end_of_turn_confidence ?? 0;

    if (event === 'StartOfTurn') {
      this.emitTranscript({
        text: '',
        isFinal: false,
        confidence: 0,
        eventType: 'SpeechStarted',
        requestId,
        fluxEvent: 'StartOfTurn',
      });
      return;
    }

    if (event === 'Update') {
      this.emitTranscript({
        text,
        isFinal: false,
        confidence: 0.8,
        eventType: 'Results',
        words: msg.words,
        requestId,
        fluxEvent: 'Update',
      });
      return;
    }

    if (event === 'EagerEndOfTurn') {
      this.emitTranscript({
        text,
        isFinal: true,
        speechFinal: true,
        confidence: endOfTurnConfidence || 0.75,
        eventType: 'Results',
        words: msg.words,
        requestId,
        fluxEvent: 'EagerEndOfTurn',
        endOfTurnConfidence,
      });
      return;
    }

    if (event === 'TurnResumed') {
      this.emitTranscript({
        text,
        isFinal: false,
        confidence: 0.5,
        eventType: 'SpeechStarted',
        requestId,
        fluxEvent: 'TurnResumed',
      });
      return;
    }

    if (event === 'EndOfTurn') {
      this.emitTranscript({
        text,
        isFinal: true,
        speechFinal: true,
        confidence: endOfTurnConfidence || 0.95,
        eventType: 'UtteranceEnd',
        words: msg.words,
        requestId,
        fluxEvent: 'EndOfTurn',
        endOfTurnConfidence,
      });
    }
  }

  sendAudio(audio: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && audio.length > 0) {
      this.ws.send(audio);
    }
  }

  onTranscript(callback: TranscriptCallback): void {
    this.transcriptCallbacks.add(callback);
  }

  offTranscript(callback: TranscriptCallback): void {
    this.transcriptCallbacks.delete(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.add(callback);
  }

  offError(callback: ErrorCallback): void {
    this.errorCallbacks.delete(callback);
  }

  finalize(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'Finalize' }));
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    this.running = false;
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private emitTranscript(transcript: Transcript & { fluxEvent?: FluxEventType; endOfTurnConfidence?: number }): void {
    for (const cb of this.transcriptCallbacks) {
      try {
        Promise.resolve(cb(transcript)).catch((err) =>
          getLogger().error(`DeepgramFluxSTT transcript callback failed: ${String(err)}`),
        );
      } catch (err) {
        getLogger().error(`DeepgramFluxSTT transcript callback threw: ${String(err)}`);
      }
    }
  }

  private emitError(err: Error): void {
    for (const cb of this.errorCallbacks) {
      try {
        cb(err);
      } catch (cbErr) {
        getLogger().error(`DeepgramFluxSTT error callback threw: ${String(cbErr)}`);
      }
    }
  }
}
