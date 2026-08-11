/**
 * r2-model-loader.mocked.test.ts
 *
 * Full unit test coverage of src/utils/r2-model-loader.ts.
 * All external I/O is mocked — no real R2, no real zstd, no real filesystem.
 *
 * Mock strategy:
 *   - @aws-sdk/client-s3  → vi.mock() intercepts the dynamic import
 *   - @mongodb-js/zstd    → vi.mock() intercepts the dynamic import
 *   - node:fs             → vi.mock() stubs mkdir + writeFile
 *   - node:crypto         → real (SHA-256 computed on mock data)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';

// ── module mocks (hoisted by vitest before any imports) ──────────────────────

const { mockSend, MockS3Client, MockGetObjectCommand, mockDecompress, mockMkdir, mockWriteFile, mockRename } = vi.hoisted(() => {
  const mockSend            = vi.fn();
  const MockS3Client        = vi.fn(() => ({ send: mockSend }));
  const MockGetObjectCommand = vi.fn((input: Record<string, unknown>) => ({ _input: input }));
  const mockDecompress      = vi.fn(async (buf: Buffer) => buf);
  const mockMkdir           = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile       = vi.fn().mockResolvedValue(undefined);
  const mockRename          = vi.fn().mockResolvedValue(undefined);
  return { mockSend, MockS3Client, MockGetObjectCommand, mockDecompress, mockMkdir, mockWriteFile, mockRename };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         MockS3Client,
  GetObjectCommand: MockGetObjectCommand,
}));

vi.mock('@mongodb-js/zstd', () => ({ decompress: mockDecompress }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, mkdir: mockMkdir, writeFile: mockWriteFile, rename: mockRename },
  };
});

// ── system under test ────────────────────────────────────────────────────────

import { fetchModelFromR2, clearR2LoaderCache } from '../src/utils/r2-model-loader';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a Node.js Readable stream from a Buffer (simulates S3 Body). */
function makeReadable(data: Buffer): Readable {
  const r = new Readable({ read() {} });
  r.push(data);
  r.push(null);
  return r;
}

/** Shared R2 credentials (never reach real network). */
const BASE_OPTS = {
  r2Endpoint:       'https://acct.r2.cloudflarestorage.com',
  r2AccessKeyId:    'FAKE_KEY',
  r2SecretAccessKey:'FAKE_SECRET',
  bucket:           'test-bucket',
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('r2-model-loader', () => {
  beforeEach(() => {
    clearR2LoaderCache();
    vi.clearAllMocks();
    mockDecompress.mockImplementation(async (buf: Buffer) => buf);
  });

  afterEach(() => {
    clearR2LoaderCache();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  it('happy path: 4 shards → assembled → decompressed → file written → path returned', async () => {
    const shards = ['s0', 's1', 's2', 's3'];
    const shardData = shards.map((_, i) => Buffer.alloc(6 * 1024 * 1024, i)); // 6 MB each

    mockSend.mockImplementation(async (cmd: { _input: { Key: string } }) => {
      const idx = shards.indexOf(cmd._input.Key);
      return { Body: makeReadable(shardData[idx]) };
    });

    const path = await fetchModelFromR2({
      ...BASE_OPTS,
      shardKeys: shards,
      modelKey: 'test_model',
    });

    // Path points into /tmp/patter-models
    expect(path).toMatch(/\/tmp\/patter-models\/test_model\.onnx$/);

    // S3 called once per shard
    expect(mockSend).toHaveBeenCalledTimes(4);

    // Assembled buffer passed to decompress (all 4 shards concatenated)
    const expectedAssembled = Buffer.concat(shardData);
    const [decompressArg] = mockDecompress.mock.calls[0];
    expect(decompressArg).toEqual(expectedAssembled);

    // File written to the correct path
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [writePath] = mockWriteFile.mock.calls[0];
    expect(writePath).toBe(path);
  });

  // ── 2. Single shard ────────────────────────────────────────────────────────
  it('works with a single shard', async () => {
    const data = Buffer.from('onnx-model-bytes');
    mockSend.mockResolvedValue({ Body: makeReadable(data) });

    const path = await fetchModelFromR2({
      ...BASE_OPTS,
      shardKeys: ['models/single.onnx.zst'],
      modelKey:  'single',
    });

    expect(path).toContain('single.onnx');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // ── 3. Shard download failure ──────────────────────────────────────────────
  it('throws with shard key in message when S3 returns an error', async () => {
    mockSend.mockImplementation(async (cmd: { _input: { Key: string } }) => {
      if (cmd._input.Key === 'models/bad.zst.001') {
        throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
      }
      return { Body: makeReadable(Buffer.from('ok')) };
    });

    await expect(
      fetchModelFromR2({
        ...BASE_OPTS,
        shardKeys: ['models/bad.zst.000', 'models/bad.zst.001'],
        modelKey:  'bad',
      })
    ).rejects.toThrow('models/bad.zst.001');
  });

  // ── 4. Concurrency cap ─────────────────────────────────────────────────────
  it('respects concurrency cap: 4 shards with concurrency=2 run in two batches', async () => {
    const order: number[] = [];
    const shards = ['s0', 's1', 's2', 's3'];
    let inFlight = 0;
    let maxInFlight = 0;

    mockSend.mockImplementation(async (cmd: { _input: { Key: string } }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(inFlight);
      await new Promise((r) => setTimeout(r, 5)); // tiny async gap
      inFlight--;
      return { Body: makeReadable(Buffer.from(cmd._input.Key)) };
    });

    await fetchModelFromR2({
      ...BASE_OPTS,
      shardKeys:   shards,
      modelKey:    'conc',
      concurrency: 2,
    });

    // With concurrency=2 and 4 shards, max in-flight should never exceed 2
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  // ── 5. SHA-256 integrity pass ──────────────────────────────────────────────
  it('passes when expectedSha256 matches the decompressed bytes', async () => {
    const content = Buffer.from('valid-onnx-data');
    const sha256  = crypto.createHash('sha256').update(content).digest('hex');

    mockSend.mockResolvedValue({ Body: makeReadable(Buffer.from('compressed')) });
    mockDecompress.mockResolvedValue(content);

    await expect(
      fetchModelFromR2({
        ...BASE_OPTS,
        shardKeys:      ['shard0'],
        modelKey:       'sha-ok',
        expectedSha256: sha256,
      })
    ).resolves.toContain('sha-ok.onnx');
  });

  // ── 6. SHA-256 integrity fail ──────────────────────────────────────────────
  it('throws a descriptive error when SHA-256 checksum does not match', async () => {
    const content = Buffer.from('onnx-bytes');
    mockSend.mockResolvedValue({ Body: makeReadable(Buffer.from('compressed')) });
    mockDecompress.mockResolvedValue(content);

    await expect(
      fetchModelFromR2({
        ...BASE_OPTS,
        shardKeys:      ['shard0'],
        modelKey:       'sha-fail',
        expectedSha256: 'a'.repeat(64), // wrong hash
      })
    ).rejects.toThrow(/SHA-256.*sha-fail/i);
  });

  // ── 7. Dedup cache: concurrent identical calls → S3 called once ─────────────
  it('dedup cache: two simultaneous fetchModelFromR2 calls for same key hit S3 only once per shard', async () => {
    const data = Buffer.from('model-bytes');
    mockSend.mockResolvedValue({ Body: makeReadable(data) });

    // Fire two calls for the same modelKey simultaneously
    const [p1, p2] = await Promise.all([
      fetchModelFromR2({ ...BASE_OPTS, shardKeys: ['s0'], modelKey: 'dedup' }),
      fetchModelFromR2({ ...BASE_OPTS, shardKeys: ['s0'], modelKey: 'dedup' }),
    ]);

    expect(p1).toBe(p2);                      // same resolved path
    expect(mockSend).toHaveBeenCalledTimes(1); // only one S3 request
  });

  // ── 8. Cache cleared on failure → retry works ────────────────────────────────
  it('clears cache on failure so a retry can succeed', async () => {
    // First call fails
    mockSend.mockRejectedValueOnce(new Error('network-error'));

    await expect(
      fetchModelFromR2({ ...BASE_OPTS, shardKeys: ['s0'], modelKey: 'retry' })
    ).rejects.toThrow();

    // Second call (after auto-cache-clear) should succeed
    mockSend.mockResolvedValue({ Body: makeReadable(Buffer.from('ok')) });
    const path = await fetchModelFromR2({ ...BASE_OPTS, shardKeys: ['s0'], modelKey: 'retry' });
    expect(path).toContain('retry.onnx');
  });

  // ── 9. Missing R2 endpoint → descriptive error ──────────────────────────────
  it('throws a descriptive error when r2Endpoint is missing', async () => {
    const savedEnv = process.env['PATTER_R2_ENDPOINT'];
    delete process.env['PATTER_R2_ENDPOINT'];
    try {
      await expect(
        fetchModelFromR2({
          r2AccessKeyId:    'key',
          r2SecretAccessKey:'secret',
          bucket:           'bucket',
          shardKeys:        ['s0'],
          modelKey:         'test',
        })
      ).rejects.toThrow(/PATTER_R2_ENDPOINT/);
    } finally {
      if (savedEnv !== undefined) process.env['PATTER_R2_ENDPOINT'] = savedEnv;
    }
  });

  // ── 10. Missing bucket → descriptive error ──────────────────────────────────
  it('throws a descriptive error when bucket is missing', async () => {
    const saved = process.env['PATTER_R2_BUCKET'];
    delete process.env['PATTER_R2_BUCKET'];
    try {
      await expect(
        fetchModelFromR2({
          r2Endpoint:       'https://x.r2.cloudflarestorage.com',
          r2AccessKeyId:    'key',
          r2SecretAccessKey:'secret',
          shardKeys:        ['s0'],
          modelKey:         'test',
        })
      ).rejects.toThrow(/bucket/i);
    } finally {
      if (saved !== undefined) process.env['PATTER_R2_BUCKET'] = saved;
    }
  });

  // ── 11. Empty shardKeys → descriptive error ─────────────────────────────────
  it('throws when shardKeys is empty', async () => {
    await expect(
      fetchModelFromR2({ ...BASE_OPTS, shardKeys: [], modelKey: 'empty' })
    ).rejects.toThrow(/shardKeys/i);
  });

  // ── 12. S3 body is null → error ─────────────────────────────────────────────
  it('throws when S3 response body is null', async () => {
    mockSend.mockResolvedValue({ Body: null });
    await expect(
      fetchModelFromR2({ ...BASE_OPTS, shardKeys: ['s0'], modelKey: 'null-body' })
    ).rejects.toThrow();
  });

  // ── 13. Per-shard timeout fires AbortError ──────────────────────────────────
  it('throws when a shard exceeds the per-shard timeout', async () => {
    mockSend.mockImplementation(async (_: unknown, opts: { abortSignal?: AbortSignal }) => {
      // Simulate a slow response by waiting indefinitely until aborted
      await new Promise<void>((_, reject) => {
        opts?.abortSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
        );
      });
    });

    await expect(
      fetchModelFromR2({
        ...BASE_OPTS,
        shardKeys: ['slow-shard'],
        modelKey:  'timeout',
        timeoutMs: 30,
      })
    ).rejects.toThrow();
  }, 2000);
});
