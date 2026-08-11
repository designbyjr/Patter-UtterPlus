/**
 * Telnyx Wav2Vec2 End-of-Speech Turn Detector facade export.
 */

import { TelnyxWav2Vec2EOS, type TelnyxWav2Vec2EOSOptions } from '../providers/telnyx-wav2vec2';

export class TurnDetector extends TelnyxWav2Vec2EOS {
  static override readonly providerKey = 'telnyx_wav2vec2_eos';

  constructor(options: TelnyxWav2Vec2EOSOptions = {}) {
    super(options);
  }
}

export type { TelnyxWav2Vec2EOSOptions };
