/**
 * container-model-warmup.mocked.test.ts
 *
 * Full unit test coverage of src/utils/container-model-warmup.ts.
 * Mocks r2-model-loader so no real network calls occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── module mocks ──────────────────────────────────────────────────────────────

const { mockFetchModelFromR2, mockClearR2LoaderCache } = vi.hoisted(() => ({
  mockFetchModelFromR2:   vi.fn(),
  mockClearR2LoaderCache: vi.fn(),
}));

vi.mock('../src/utils/r2-model-loader', () => ({
  fetchModelFromR2:   mockFetchModelFromR2,
  clearR2LoaderCache: mockClearR2LoaderCache,
}));

// ── system under test ────────────────────────────────────────────────────────

import { warmContainerModels } from '../src/utils/container-model-warmup';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Set R2 env vars and return a cleanup function. */
function setR2Env() {
  process.env['PATTER_R2_ENDPOINT']          = 'https://acct.r2.cloudflarestorage.com';
  process.env['PATTER_R2_ACCESS_KEY_ID']     = 'FAKE_KEY';
  process.env['PATTER_R2_SECRET_ACCESS_KEY'] = 'FAKE_SECRET';
  process.env['PATTER_R2_BUCKET']            = 'test-bucket';
  return () => {
    delete process.env['PATTER_R2_ENDPOINT'];
    delete process.env['PATTER_R2_ACCESS_KEY_ID'];
    delete process.env['PATTER_R2_SECRET_ACCESS_KEY'];
    delete process.env['PATTER_R2_BUCKET'];
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('container-model-warmup: warmContainerModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any env vars set by previous tests
    delete process.env['PATTER_TENVAD_MODEL'];
    delete process.env['PATTER_TELNYX_EOS_MODEL'];
    delete process.env['PATTER_SMART_TURN_MODEL'];
    delete process.env['PATTER_TENVAD_SHARDS'];
    delete process.env['PATTER_TELNYX_EOS_SHARDS'];
    delete process.env['PATTER_SMART_TURN_SHARDS'];
  });

  afterEach(() => {
    delete process.env['PATTER_TENVAD_MODEL'];
    delete process.env['PATTER_TELNYX_EOS_MODEL'];
    delete process.env['PATTER_SMART_TURN_MODEL'];
  });

  // ── 1. No R2 credentials → immediate no-op ────────────────────────────────
  it('returns all-null result instantly when R2 credentials are absent', async () => {
    const result = await warmContainerModels({
      tenVadShards: ['s0'],
    });

    expect(result.tenVadPath).toBeNull();
    expect(result.telnyxEosPath).toBeNull();
    expect(result.smartTurnPath).toBeNull();
    expect(mockFetchModelFromR2).not.toHaveBeenCalled();
  });

  // ── 2. No shard lists configured → no-op ──────────────────────────────────
  it('returns all-null result when no shard lists are configured', async () => {
    const cleanup = setR2Env();
    try {
      const result = await warmContainerModels();
      expect(result.tenVadPath).toBeNull();
      expect(result.telnyxEosPath).toBeNull();
      expect(result.smartTurnPath).toBeNull();
      expect(mockFetchModelFromR2).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  // ── 3. All three models download successfully ──────────────────────────────
  it('downloads all three models concurrently and sets env vars', async () => {
    const cleanup = setR2Env();
    try {
      mockFetchModelFromR2
        .mockResolvedValueOnce('/tmp/patter-models/ten_vad.onnx')
        .mockResolvedValueOnce('/tmp/patter-models/telnyx_wav2vec2_eos_int8.onnx')
        .mockResolvedValueOnce('/tmp/patter-models/smart_turn_v3.onnx');

      const result = await warmContainerModels({
        tenVadShards:    ['tv0', 'tv1'],
        telnyxEosShards: ['eos0'],
        smartTurnShards: ['st0', 'st1', 'st2'],
      });

      expect(result.tenVadPath).toBe('/tmp/patter-models/ten_vad.onnx');
      expect(result.telnyxEosPath).toBe('/tmp/patter-models/telnyx_wav2vec2_eos_int8.onnx');
      expect(result.smartTurnPath).toBe('/tmp/patter-models/smart_turn_v3.onnx');

      // Env vars must be set so providers auto-discover the paths
      expect(process.env['PATTER_TENVAD_MODEL']).toBe('/tmp/patter-models/ten_vad.onnx');
      expect(process.env['PATTER_TELNYX_EOS_MODEL']).toBe('/tmp/patter-models/telnyx_wav2vec2_eos_int8.onnx');
      expect(process.env['PATTER_SMART_TURN_MODEL']).toBe('/tmp/patter-models/smart_turn_v3.onnx');

      expect(mockFetchModelFromR2).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });

  // ── 4. One model fails → others still succeed ─────────────────────────────
  it('gracefully handles one model failure while downloading the other two', async () => {
    const cleanup = setR2Env();
    try {
      mockFetchModelFromR2
        .mockResolvedValueOnce('/tmp/patter-models/ten_vad.onnx')
        .mockRejectedValueOnce(new Error('R2 404 — shard not found'))
        .mockResolvedValueOnce('/tmp/patter-models/smart_turn_v3.onnx');

      const result = await warmContainerModels({
        tenVadShards:    ['tv0'],
        telnyxEosShards: ['eos0'],
        smartTurnShards: ['st0'],
      });

      expect(result.tenVadPath).toBe('/tmp/patter-models/ten_vad.onnx');
      expect(result.telnyxEosPath).toBeNull();           // failed
      expect(result.smartTurnPath).toBe('/tmp/patter-models/smart_turn_v3.onnx');

      expect(process.env['PATTER_TENVAD_MODEL']).toBe('/tmp/patter-models/ten_vad.onnx');
      expect(process.env['PATTER_TELNYX_EOS_MODEL']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // ── 5. All models fail → all paths null, no throw ─────────────────────────
  it('does not throw even when every model download fails', async () => {
    const cleanup = setR2Env();
    try {
      mockFetchModelFromR2.mockRejectedValue(new Error('network error'));

      const result = await warmContainerModels({
        tenVadShards:    ['t0'],
        telnyxEosShards: ['e0'],
        smartTurnShards: ['s0'],
      });

      expect(result.tenVadPath).toBeNull();
      expect(result.telnyxEosPath).toBeNull();
      expect(result.smartTurnPath).toBeNull();
    } finally {
      cleanup();
    }
  });

  // ── 6. elapsedMs is a non-negative number ────────────────────────────────
  it('reports a non-negative elapsedMs', async () => {
    const cleanup = setR2Env();
    try {
      mockFetchModelFromR2.mockResolvedValue('/tmp/patter-models/ten_vad.onnx');
      const result = await warmContainerModels({ tenVadShards: ['s0'] });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  // ── 7. onProgress callback fires for each download ───────────────────────
  it('calls onProgress once per model after each download completes', async () => {
    const cleanup = setR2Env();
    try {
      mockFetchModelFromR2
        .mockResolvedValueOnce('/tmp/patter-models/ten_vad.onnx')
        .mockResolvedValueOnce('/tmp/patter-models/telnyx_wav2vec2_eos_int8.onnx');

      const messages: string[] = [];
      await warmContainerModels({
        tenVadShards:    ['tv0'],
        telnyxEosShards: ['eos0'],
        onProgress: (msg) => messages.push(msg),
      });

      expect(messages.length).toBe(2);
      expect(messages.some((m) => m.includes('ten_vad'))).toBe(true);
      expect(messages.some((m) => m.includes('telnyx_wav2vec2'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  // ── 8. Shards read from env vars (PATTER_*_SHARDS) ───────────────────────
  it('reads shard lists from env vars when not provided in options', async () => {
    const cleanup = setR2Env();
    try {
      process.env['PATTER_TENVAD_SHARDS'] = 'models/tv0,models/tv1';
      mockFetchModelFromR2.mockResolvedValue('/tmp/patter-models/ten_vad.onnx');

      const result = await warmContainerModels();

      expect(result.tenVadPath).toBe('/tmp/patter-models/ten_vad.onnx');
      // fetchModelFromR2 should receive the parsed shard keys
      expect(mockFetchModelFromR2).toHaveBeenCalledWith(
        expect.objectContaining({
          shardKeys: ['models/tv0', 'models/tv1'],
          modelKey:  'ten_vad',
        })
      );
    } finally {
      cleanup();
      delete process.env['PATTER_TENVAD_SHARDS'];
    }
  });

  // ── 9. Opts shards override env vars ─────────────────────────────────────
  it('uses explicit shardKeys from opts over PATTER_*_SHARDS env vars', async () => {
    const cleanup = setR2Env();
    try {
      process.env['PATTER_TENVAD_SHARDS'] = 'env/shard0';
      mockFetchModelFromR2.mockResolvedValue('/tmp/patter-models/ten_vad.onnx');

      await warmContainerModels({ tenVadShards: ['opts/shard0', 'opts/shard1'] });

      expect(mockFetchModelFromR2).toHaveBeenCalledWith(
        expect.objectContaining({ shardKeys: ['opts/shard0', 'opts/shard1'] })
      );
    } finally {
      cleanup();
      delete process.env['PATTER_TENVAD_SHARDS'];
    }
  });

  // ── 10. Returns elapsedMs=0 when skipping (no R2) ─────────────────────────
  it('returns elapsedMs=0 when warm-up is skipped due to missing credentials', async () => {
    const result = await warmContainerModels({ tenVadShards: ['s0'] });
    expect(result.elapsedMs).toBe(0);
  });
});
