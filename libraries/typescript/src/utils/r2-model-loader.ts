/**
 * R2 Zstd Shard ONNX Model Loader — parallel shard pull + decompression.
 *
 * Downloads pre-split zstd-compressed ONNX model shards from Cloudflare R2
 * in parallel, reassembles and decompresses them, writes to /tmp/patter-models/,
 * and returns the absolute path for ort.InferenceSession.create(path).
 *
 * Optional dependencies: @aws-sdk/client-s3, @mongodb-js/zstd
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { getLogger } from '../logger';

export interface R2ModelLoaderOptions {
  readonly r2Endpoint?: string;
  readonly r2AccessKeyId?: string;
  readonly r2SecretAccessKey?: string;
  readonly workerEndpoint?: string;
  readonly bucket?: string;
  readonly shardKeys: readonly string[];
  readonly modelKey: string;
  readonly expectedSha256?: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

const TMP_DIR = '/tmp/patter-models';
const loaderCache = new Map<string, Promise<string>>();

async function streamToBuffer(body: Readable | ReadableStream | unknown): Promise<Buffer> {
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof (body as ReadableStream).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
  throw new Error('R2ModelLoader: unrecognised response body type');
}

async function downloadShardWithRetry(
  fetchFn: () => Promise<Buffer>,
  key: string,
  maxRetries = 3
): Promise<Buffer> {
  let attempt = 0;
  while (true) {
    try {
      return await fetchFn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(
          `[PATTER] R2ModelLoader: failed downloading shard "${key}" after ${maxRetries} retries: ${
            (err as Error)?.message
          }`
        );
      }
      const backoffMs = Math.min(1000, 100 * Math.pow(2, attempt - 1)) + Math.random() * 50;
      getLogger().warn(
        `[PATTER] R2ModelLoader: shard "${key}" retry ${attempt}/${maxRetries} in ${Math.round(
          backoffMs
        )}ms (${(err as Error)?.message})`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

async function downloadShard(
  s3: unknown,
  GetObjectCommand: new (input: Record<string, unknown>) => unknown,
  bucket: string,
  key: string,
  timeoutMs: number,
  workerEndpoint?: string
): Promise<Buffer> {
  return await downloadShardWithRetry(async () => {
    if (workerEndpoint) {
      const url = `${workerEndpoint.replace(/\/$/, '')}/shards/${encodeURIComponent(key)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Worker R2 HTTP error ${res.status}: ${res.statusText}`);
        }
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      } finally {
        clearTimeout(timer);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (s3 as any).send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: controller.signal }
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (response as any).Body;
      if (!body) throw new Error(`Empty body returned for R2 key: ${key}`);
      return await streamToBuffer(body);
    } finally {
      clearTimeout(timer);
    }
  }, key);
}

async function loadS3Dependencies(opts: R2ModelLoaderOptions): Promise<{
  s3: unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
}> {
  const endpoint = opts.r2Endpoint ?? process.env['PATTER_R2_ENDPOINT'];
  const accessKeyId = opts.r2AccessKeyId ?? process.env['PATTER_R2_ACCESS_KEY_ID'];
  const secretAccessKey = opts.r2SecretAccessKey ?? process.env['PATTER_R2_SECRET_ACCESS_KEY'];

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'fetchModelFromR2: R2 credentials are required. Set PATTER_R2_ENDPOINT, ' +
        'PATTER_R2_ACCESS_KEY_ID, and PATTER_R2_SECRET_ACCESS_KEY.'
    );
  }

  let S3Client: any;
  let GetObjectCommand: any;
  try {
    const mod: any = await import('@aws-sdk/client-s3');
    S3Client = mod.S3Client;
    GetObjectCommand = mod.GetObjectCommand;
  } catch {
    throw new Error(
      'fetchModelFromR2 requires "@aws-sdk/client-s3" — install with: npm install @aws-sdk/client-s3'
    );
  }

  const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
  return { s3, GetObjectCommand };
}

async function loadZstd(): Promise<(buf: Buffer) => Promise<Buffer>> {
  try {
    // @ts-ignore
    const mod = await import('@mongodb-js/zstd');
    return (mod.decompress ?? mod.default?.decompress) as (buf: Buffer) => Promise<Buffer>;
  } catch {
    throw new Error(
      'fetchModelFromR2 requires "@mongodb-js/zstd" — install with: npm install @mongodb-js/zstd'
    );
  }
}

export async function fetchModelFromR2(opts: R2ModelLoaderOptions): Promise<string> {
  const bucket = opts.bucket ?? process.env['PATTER_R2_BUCKET'];
  if (!bucket) throw new Error('fetchModelFromR2: bucket is required. Set PATTER_R2_BUCKET.');
  if (opts.shardKeys.length === 0) throw new Error('fetchModelFromR2: shardKeys must be a non-empty array.');

  const cacheKey = `${bucket}:${opts.modelKey}`;
  if (loaderCache.has(cacheKey)) return loaderCache.get(cacheKey)!;

  const promise = (async (): Promise<string> => {
    const startMs = Date.now();
    const defaultConcurrency =
      parseInt(process.env['PATTER_SHARD_CONCURRENCY'] ?? '', 10) ||
      Math.max(8, (os.availableParallelism?.() ?? os.cpus().length) * 2);
    const concurrency = opts.concurrency ?? defaultConcurrency;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const shards = Array.from(opts.shardKeys);

    getLogger().info(`[PATTER] R2ModelLoader: downloading ${shards.length} shard(s) for "${opts.modelKey}"`);

    const workerEndpoint = opts.workerEndpoint ?? process.env['PATTER_R2_WORKER_URL'];
    let s3: unknown = null;
    let GetObjectCommand: any = null;

    if (!workerEndpoint) {
      const deps = await loadS3Dependencies(opts);
      s3 = deps.s3;
      GetObjectCommand = deps.GetObjectCommand;
    } else {
      getLogger().info(`[PATTER] R2ModelLoader: using Cloudflare Worker R2 outbound binding at ${workerEndpoint}`);
    }

    const results: Buffer[] = new Array(shards.length);
    let index = 0;

    async function worker(): Promise<void> {
      while (true) {
        const i = index++;
        if (i >= shards.length) return;
        results[i] = await downloadShard(s3, GetObjectCommand, bucket!, shards[i], timeoutMs, workerEndpoint);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, () => worker()));

    const assembled = Buffer.concat(results);
    getLogger().info(`[PATTER] R2ModelLoader: assembled ${assembled.length} bytes in ${Date.now() - startMs}ms`);

    const decompress = await loadZstd();
    const decompressed = await decompress(assembled);

    if (opts.expectedSha256) {
      const actual = crypto.createHash('sha256').update(decompressed).digest('hex');
      if (actual !== opts.expectedSha256) {
        throw new Error(
          `[PATTER] R2ModelLoader: SHA-256 integrity check failed for "${opts.modelKey}". Expected ${opts.expectedSha256}, got ${actual}.`
        );
      }
    }

    const scratchDir = path.join(TMP_DIR, 'scratch');
    await fs.promises.mkdir(scratchDir, { recursive: true });
    await fs.promises.mkdir(TMP_DIR, { recursive: true });

    const scratchPath = path.join(scratchDir, `${opts.modelKey}.tmp`);
    const outPath = path.join(TMP_DIR, `${opts.modelKey}.onnx`);

    if (fs.existsSync(outPath)) {
      return outPath;
    }

    await fs.promises.writeFile(scratchPath, decompressed);
    await fs.promises.rename(scratchPath, outPath);

    getLogger().info(`[PATTER] R2ModelLoader: "${opts.modelKey}" ready at ${outPath} (${Date.now() - startMs}ms)`);
    return outPath;
  })();

  loaderCache.set(cacheKey, promise);
  promise.catch(() => loaderCache.delete(cacheKey));
  return promise;
}

export function clearR2LoaderCache(): void {
  loaderCache.clear();
}
