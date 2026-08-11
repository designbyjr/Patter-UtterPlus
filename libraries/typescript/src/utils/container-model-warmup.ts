/**
 * Container model warm-up orchestrator for Cloudflare container cold boot.
 *
 * Fires parallel R2 shard downloads for TenVAD, TelnyxWav2Vec2EOS, and
 * SmartTurnDetector ONNX models at container startup. Sets PATTER_*_MODEL
 * env vars so providers auto-discover the downloaded paths.
 */

import { getLogger } from '../logger';
import { fetchModelFromR2, type R2ModelLoaderOptions } from './r2-model-loader';

export interface ContainerModelWarmupOptions {
  readonly tenVadShards?: readonly string[];
  readonly telnyxEosShards?: readonly string[];
  readonly smartTurnShards?: readonly string[];
  readonly r2?: Partial<R2ModelLoaderOptions>;
  readonly onProgress?: (msg: string) => void;
}

export interface WarmupResult {
  readonly tenVadPath: string | null;
  readonly telnyxEosPath: string | null;
  readonly smartTurnPath: string | null;
  readonly elapsedMs: number;
}

function parseShardsEnv(envVar: string): readonly string[] | undefined {
  const raw = process.env[envVar]?.trim();
  if (!raw) return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function hasR2Credentials(r2Base: Partial<R2ModelLoaderOptions>): boolean {
  return (
    Boolean(r2Base.r2Endpoint ?? process.env['PATTER_R2_ENDPOINT']) &&
    Boolean(r2Base.r2AccessKeyId ?? process.env['PATTER_R2_ACCESS_KEY_ID']) &&
    Boolean(r2Base.r2SecretAccessKey ?? process.env['PATTER_R2_SECRET_ACCESS_KEY'])
  );
}

export async function warmContainerModels(opts: ContainerModelWarmupOptions = {}): Promise<WarmupResult> {
  const startMs = Date.now();
  const r2Base: Partial<R2ModelLoaderOptions> = opts.r2 ?? {};

  if (!hasR2Credentials(r2Base)) {
    getLogger().debug('[PATTER] ContainerModelWarmup: no R2 credentials — skipping');
    return { tenVadPath: null, telnyxEosPath: null, smartTurnPath: null, elapsedMs: 0 };
  }

  const tenVadShards = opts.tenVadShards ?? parseShardsEnv('PATTER_TENVAD_SHARDS');
  const telnyxEosShards = opts.telnyxEosShards ?? parseShardsEnv('PATTER_TELNYX_EOS_SHARDS');
  const smartTurnShards = opts.smartTurnShards ?? parseShardsEnv('PATTER_SMART_TURN_SHARDS');

  if (!tenVadShards && !telnyxEosShards && !smartTurnShards) {
    getLogger().debug('[PATTER] ContainerModelWarmup: no shard lists configured — skipping');
    return { tenVadPath: null, telnyxEosPath: null, smartTurnPath: null, elapsedMs: 0 };
  }

  getLogger().info('[PATTER] ContainerModelWarmup: starting parallel ONNX model downloads from R2');

  async function downloadModel(
    shards: readonly string[] | undefined,
    modelKey: string,
    envVar: string
  ): Promise<string | null> {
    if (!shards || shards.length === 0) return null;
    try {
      const loaderOpts: R2ModelLoaderOptions = { ...r2Base, shardKeys: shards, modelKey } as R2ModelLoaderOptions;
      const modelPath = await fetchModelFromR2(loaderOpts);
      process.env[envVar] = modelPath;
      opts.onProgress?.(`${modelKey}: loaded (${modelPath})`);
      return modelPath;
    } catch (err) {
      getLogger().warn(`[PATTER] ContainerModelWarmup: ${modelKey} failed — acoustic fallback: ${(err as Error).message}`);
      opts.onProgress?.(`${modelKey}: failed (acoustic fallback)`);
      return null;
    }
  }

  const [tenVadPath, telnyxEosPath, smartTurnPath] = await Promise.all([
    downloadModel(tenVadShards,    'ten_vad',                    'PATTER_TENVAD_MODEL'),
    downloadModel(telnyxEosShards, 'telnyx_wav2vec2_eos_int8',   'PATTER_TELNYX_EOS_MODEL'),
    downloadModel(smartTurnShards, 'smart_turn_v3',              'PATTER_SMART_TURN_MODEL'),
  ]);

  const elapsedMs = Date.now() - startMs;
  getLogger().info(
    `[PATTER] ContainerModelWarmup: complete in ${elapsedMs}ms — ` +
    `tenVad=${tenVadPath ? 'OK' : 'skip'}, telnyxEos=${telnyxEosPath ? 'OK' : 'skip'}, smartTurn=${smartTurnPath ? 'OK' : 'skip'}`
  );

  return { tenVadPath, telnyxEosPath, smartTurnPath, elapsedMs };
}
