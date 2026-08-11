/** Deepgram Flux WebSocket streaming STT for Patter pipeline mode. */
import {
  DeepgramFluxSTT as _DeepgramFluxSTT,
  type DeepgramFluxSTTOptions as _DeepgramFluxSTTOptions,
} from "../providers/deepgram-flux-stt";

export type DeepgramFluxSTTOptions = _DeepgramFluxSTTOptions & {
  /**
   * Cloudflare Worker URL or Deepgram Flux WebSocket endpoint.
   * Falls back to DEEPGRAM_FLUX_URL env var when omitted.
   */
  url?: string;
  /** API key. Falls back to DEEPGRAM_API_KEY env var when omitted. */
  apiKey?: string;
};

/**
 * Deepgram Flux streaming STT via WebSocket.
 *
 * Connects to Cloudflare Workers AI (`@cf/deepgram/flux`) or a Deepgram Flux
 * WebSocket endpoint and parses `TurnInfo` messages into Patter-normalized
 * transcripts, including `StartOfTurn`, `Update`, `EagerEndOfTurn`,
 * `TurnResumed`, and `EndOfTurn` events.
 *
 * @example
 * ```ts
 * import * as deepgramFlux from "getpatter/stt/deepgram-flux";
 * const stt = new deepgramFlux.STT({ url: "wss://...", apiKey: "dg_..." });
 * ```
 */
export class STT extends _DeepgramFluxSTT {
  static readonly providerKey = "deepgram_flux";
  constructor(opts: DeepgramFluxSTTOptions = {}) {
    const url = opts.url ?? process.env.DEEPGRAM_FLUX_URL;
    const apiKey = opts.apiKey ?? process.env.DEEPGRAM_API_KEY;
    super({ ...opts, url, apiKey });
  }
}
