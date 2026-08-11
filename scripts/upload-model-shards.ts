/**
 * upload-model-shards.ts — Compress ONNX models with Zstd into shards and upload to Cloudflare R2.
 *
 * Usage:
 *   npx ts-node scripts/upload-model-shards.ts <path-to-onnx> <model-name>
 *
 * Example:
 *   npx ts-node scripts/upload-model-shards.ts libraries/typescript/src/resources/silero_vad.onnx ten_vad
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
// @ts-ignore
import { compress } from '@mongodb-js/zstd';

const R2_BUCKET = process.env['PATTER_R2_BUCKET'] ?? 'patter-models';
const R2_ENDPOINT = process.env['PATTER_R2_ENDPOINT'] ?? 'https://27e89563673d4bcd83625e2e12948bd4.r2.cloudflarestorage.com';
const R2_ACCESS_KEY_ID = process.env['PATTER_R2_ACCESS_KEY_ID'] ?? 'e788a3e0d0ddd5c888249f0903786445';
const R2_SECRET_ACCESS_KEY = process.env['PATTER_R2_SECRET_ACCESS_KEY'] ?? '673612254416cc25049438c823a5c8b6a616675c1590b0910586cef29deee46c';
const SHARD_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB per shard

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: npx tsx scripts/upload-model-shards.ts <path-to-onnx> <model-key>');
    process.exit(1);
  }

  const [onnxPath, modelKey] = args;
  if (!fs.existsSync(onnxPath)) {
    console.error(`Error: File not found: ${onnxPath}`);
    process.exit(1);
  }

  console.log(`[PATTER R2 Uploader] Reading "${onnxPath}"...`);
  const rawBuf = await fs.promises.readFile(onnxPath);
  const sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
  console.log(`[PATTER R2 Uploader] Model size: ${(rawBuf.length / 1024 / 1024).toFixed(2)} MB, SHA256: ${sha256}`);

  console.log('[PATTER R2 Uploader] Decompressing/compressing with Zstd level 3...');
  const zstdCompressed = await compress(rawBuf, 3);
  console.log(`[PATTER R2 Uploader] Zstd compressed size: ${(zstdCompressed.length / 1024 / 1024).toFixed(2)} MB`);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const shardKeys: string[] = [];
  const numShards = Math.ceil(zstdCompressed.length / SHARD_SIZE_BYTES);

  for (let i = 0; i < numShards; i++) {
    const start = i * SHARD_SIZE_BYTES;
    const end = Math.min(start + SHARD_SIZE_BYTES, zstdCompressed.length);
    const chunk = zstdCompressed.subarray(start, end);

    const shardSuffix = String(i + 1).padStart(3, '0');
    const r2Key = `models/${modelKey}.zst.${shardSuffix}`;

    console.log(`[PATTER R2 Uploader] Uploading shard ${i + 1}/${numShards}: "${r2Key}" (${(chunk.length / 1024 / 1024).toFixed(2)} MB)...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: chunk,
        ContentType: 'application/zstd',
      })
    );
    shardKeys.push(r2Key);
  }

  console.log('\n[PATTER R2 Uploader] Upload Complete! 🚀');
  console.log(`Bucket     : ${R2_BUCKET}`);
  console.log(`Model Key  : ${modelKey}`);
  console.log(`SHA-256    : ${sha256}`);
  console.log(`Shard List : ${JSON.stringify(shardKeys)}`);
  console.log(`\nEnvironment Variable:\nPATTER_${modelKey.toUpperCase()}_SHARDS=${shardKeys.join(',')}`);
}

main().catch((err) => {
  console.error('[PATTER R2 Uploader] Fatal error:', err);
  process.exit(1);
});
