/**
 * cleanup_old_r2_files.ts
 * Deletes old un-nested top-level shards inside models/ (e.g. models/deepfilternet.zst.001),
 * leaving ONLY clean, pristine subfolder structures like models/deepfilternet2/deepfilternet2.zst.001.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const R2_BUCKET = process.env['PATTER_R2_BUCKET'] ?? 'patter-models';
const R2_ENDPOINT = process.env['PATTER_R2_ENDPOINT'] ?? 'https://27e89563673d4bcd83625e2e12948bd4.r2.cloudflarestorage.com';
const R2_ACCESS_KEY_ID = process.env['PATTER_R2_ACCESS_KEY_ID'] ?? 'e788a3e0d0ddd5c888249f0903786445';
const R2_SECRET_ACCESS_KEY = process.env['PATTER_R2_SECRET_ACCESS_KEY'] ?? '673612254416cc25049438c823a5c8b6a616675c1590b0910586cef29deee46c';

async function main() {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  console.log(`[PATTER R2 Cleanup] Listing objects under "models/" in bucket "${R2_BUCKET}"...`);
  const listRes = await s3.send(
    new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: 'models/',
    })
  );

  const objects = listRes.Contents ?? [];
  const looseFilesToDelete = objects.filter((obj) => {
    if (!obj.Key) return false;
    // Match loose files directly in models/ like "models/deepfilternet.zst.001"
    const relativePath = obj.Key.substring('models/'.length);
    return !relativePath.includes('/');
  });

  if (looseFilesToDelete.length === 0) {
    console.log('[PATTER R2 Cleanup] No loose top-level files found. Bucket is already clean! ✨');
    return;
  }

  console.log(`[PATTER R2 Cleanup] Found ${looseFilesToDelete.length} loose files to delete:`);
  for (const f of looseFilesToDelete) {
    console.log(` - ${f.Key}`);
  }

  await s3.send(
    new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: {
        Objects: looseFilesToDelete.map((f) => ({ Key: f.Key })),
      },
    })
  );

  console.log('\n[PATTER R2 Cleanup] Successfully deleted all loose top-level files! Bucket is clean and beautifully organized into folders. 🧹✨');
}

main().catch((err) => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
