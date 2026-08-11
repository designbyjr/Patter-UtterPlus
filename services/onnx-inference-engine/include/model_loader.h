#pragma once
/**
 * ModelLoader — parallel R2 shard download + in-RAM Zstd decompression.
 *
 * Implements the cold-boot path:
 *   1. Fire N parallel HTTP GET requests via libcurl multi-handle to pull
 *      pre-split zstd-compressed ONNX shards from Cloudflare R2.
 *   2. Assemble the ordered shard buffers into a single contiguous buffer.
 *   3. Decompress in-memory with ZSTD_decompress() — no disk I/O, no temp file.
 *   4. Return a std::vector<char> holding the raw ONNX flatbuffer bytes
 *      ready to pass to Ort::Session().
 *
 * Memory safety guarantees:
 *  - ZSTD_getFrameContentSize() is checked for ZSTD_CONTENTSIZE_ERROR and
 *    ZSTD_CONTENTSIZE_UNKNOWN before any allocation.
 *  - All buffers are owned by std::vector<char>; no raw new/delete.
 *  - Shard index bounds are validated before assembly.
 *  - curl handles are cleaned up in RAII wrappers even on exception.
 */

#include <cstddef>
#include <string>
#include <vector>

namespace patter {

/** Configuration for the R2 model download. */
struct R2Config {
    std::string endpoint;         ///< https://<account>.r2.cloudflarestorage.com
    std::string access_key_id;    ///< R2 / S3 access key ID
    std::string secret_key;       ///< R2 / S3 secret access key
    std::string bucket;           ///< R2 bucket name
    int         concurrency = 4;  ///< max parallel shard requests
    long        timeout_ms  = 10000; ///< per-shard timeout in milliseconds
};

/**
 * Download all shards in parallel from R2, assemble in order, and decompress.
 *
 * @param cfg       R2 endpoint + credentials. Falls back to PATTER_R2_* env vars
 *                  if the corresponding string fields are empty.
 * @param shard_keys  Ordered list of R2 object keys (e.g. {"models/vad.zst.aa", ...}).
 *
 * @return  Decompressed ONNX model bytes (raw flatbuffer).
 *
 * @throws std::runtime_error on any network, HTTP, or decompression error.
 */
std::vector<char> load_model_from_r2(
    const R2Config&                  cfg,
    const std::vector<std::string>&  shard_keys
);

/**
 * Download, decompress via C++, write to temporary /tmp file, and atomically move
 * to permanent model folder (/var/cache/patter-models/<model_key>.onnx).
 */
std::string download_and_extract_model_to_disk(
    const R2Config&                  cfg,
    const std::vector<std::string>&  shard_keys,
    const std::string&               model_key
);

/**
 * Pure decompression helper — exposed for unit-testing without network I/O.
 *
 * Memory safety:
 *  - Validates ZSTD frame content size before allocation.
 *  - Allocates exactly the required destination bytes — no over-allocation.
 *  - Throws std::runtime_error on ZSTD errors (never silent truncation).
 *
 * @param compressed  Raw zstd-compressed bytes.
 * @return            Decompressed bytes.
 */
std::vector<char> zstd_decompress(const std::vector<char>& compressed);

}  // namespace patter
