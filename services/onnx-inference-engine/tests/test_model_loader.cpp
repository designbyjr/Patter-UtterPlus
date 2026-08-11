/**
 * test_model_loader.cpp — Google Test suite for patter::zstd_decompress()
 * and the shard assembly path.
 *
 * Network-dependent tests (load_model_from_r2) are skipped by default —
 * they require real R2 credentials and are run as integration tests only.
 *
 * Pure unit tests cover:
 *   1.  Round-trip: compress → decompress produces original bytes
 *   2.  Empty input → throws
 *   3.  ZSTD_CONTENTSIZE_ERROR scenario (corrupt magic bytes) → throws with hint
 *   4.  Truncated frame → throws
 *   5.  All-zeros input → decompresses correctly
 *   6.  Large buffer (>100 KB) → decompresses without overflow
 *   7.  Exact decompressed size is allocated (no over-allocation)
 *   8.  ZSTD level 19 output decompresses correctly
 *   9.  Multi-call idempotency (decompress same data twice → same result)
 *  10.  Missing PATTER_R2_* env vars → descriptive error from load_model_from_r2
 *  11.  Empty shard_keys → throws
 */

#include <gtest/gtest.h>
#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include <zstd.h>

#include "model_loader.h"

using patter::zstd_decompress;
using patter::load_model_from_r2;
using patter::R2Config;

// ── Helper: compress bytes with libzstd ───────────────────────────────────────

static std::vector<char> zstd_compress_helper(
    const std::vector<char>& src, int level = 1
) {
    std::size_t const bound = ZSTD_compressBound(src.size());
    std::vector<char> dst(bound);
    // ZSTD_compress includes the content size in the frame header by default
    std::size_t const r = ZSTD_compress(
        dst.data(), dst.size(),
        src.data(), src.size(),
        level
    );
    if (ZSTD_isError(r)) {
        throw std::runtime_error(ZSTD_getErrorName(r));
    }
    dst.resize(r);
    return dst;
}

// ── 1. Round-trip ─────────────────────────────────────────────────────────────

TEST(ZstdDecompressTest, RoundTripProducesOriginalBytes) {
    std::vector<char> original(4096, 'A');
    auto compressed   = zstd_compress_helper(original);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_EQ(decompressed, original);
}

// ── 2. Empty input → throws ────────────────────────────────────────────────────

TEST(ZstdDecompressTest, EmptyInputThrows) {
    std::vector<char> empty;
    EXPECT_THROW(zstd_decompress(empty), std::runtime_error);
}

// ── 3. Corrupt magic bytes → ZSTD_CONTENTSIZE_ERROR → throws ─────────────────

TEST(ZstdDecompressTest, CorruptMagicBytesThrowsDescriptiveError) {
    // A buffer that is not a valid zstd frame
    std::vector<char> garbage = {0x00, 0x01, 0x02, 0x03, 0x04};
    try {
        zstd_decompress(garbage);
        FAIL() << "Expected std::runtime_error";
    } catch (const std::runtime_error& e) {
        // Message should mention CONTENTSIZE_ERROR or corrupt
        std::string msg = e.what();
        EXPECT_TRUE(
            msg.find("ZSTD_CONTENTSIZE_ERROR") != std::string::npos ||
            msg.find("corrupt") != std::string::npos ||
            msg.find("valid zstd frame") != std::string::npos
        ) << "Unexpected error message: " << msg;
    }
}

// ── 4. Truncated valid frame → decompression error ────────────────────────────

TEST(ZstdDecompressTest, TruncatedFrameThrows) {
    std::vector<char> original(1024, 'X');
    auto compressed = zstd_compress_helper(original);

    // Chop off the last 20 bytes to create a truncated frame
    if (compressed.size() > 20) {
        compressed.resize(compressed.size() - 20);
    }
    EXPECT_THROW(zstd_decompress(compressed), std::runtime_error);
}

// ── 5. All-zeros decompresses correctly ───────────────────────────────────────

TEST(ZstdDecompressTest, AllZerosRoundTrip) {
    std::vector<char> original(8192, '\0');
    auto compressed   = zstd_compress_helper(original, 3);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_EQ(decompressed.size(), original.size());
    EXPECT_EQ(decompressed, original);
}

// ── 6. Large buffer (512 KB) ─────────────────────────────────────────────────

TEST(ZstdDecompressTest, LargeBufferNoOverflow) {
    std::vector<char> original(512 * 1024);
    // Fill with pseudo-random pattern to exercise actual compression
    for (std::size_t i = 0; i < original.size(); ++i) {
        original[i] = static_cast<char>(i & 0xFF);
    }
    auto compressed   = zstd_compress_helper(original, 1);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_EQ(decompressed.size(), original.size());
    EXPECT_EQ(decompressed, original);
}

// ── 7. Exact size allocation (no over-allocation) ────────────────────────────

TEST(ZstdDecompressTest, DecompressedVectorSizeMatchesContentSize) {
    std::vector<char> original(1337, 'Z');
    auto compressed   = zstd_compress_helper(original);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_EQ(decompressed.size(), original.size()); // exactly 1337, not rounded up
}

// ── 8. Maximum compression level (zstd -19) ──────────────────────────────────

TEST(ZstdDecompressTest, Level19CompressedDataDecompressesCorrectly) {
    std::vector<char> original(4096, 'P');
    auto compressed   = zstd_compress_helper(original, 19);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_EQ(decompressed, original);
}

// ── 9. Idempotency: decompress twice → same result ───────────────────────────

TEST(ZstdDecompressTest, IdempotentOnSameInput) {
    std::vector<char> original = {'h', 'e', 'l', 'l', 'o'};
    auto compressed = zstd_compress_helper(original);
    auto d1 = zstd_decompress(compressed);
    auto d2 = zstd_decompress(compressed);
    EXPECT_EQ(d1, d2);
}

// ── 10. Empty original → empty decompressed ──────────────────────────────────

TEST(ZstdDecompressTest, EmptyOriginalRoundTrip) {
    std::vector<char> original; // zero bytes
    auto compressed   = zstd_compress_helper(original);
    auto decompressed = zstd_decompress(compressed);
    EXPECT_TRUE(decompressed.empty());
}

// ── load_model_from_r2 unit tests (no network) ───────────────────────────────

TEST(LoadModelFromR2Test, EmptyShardKeysThrows) {
    R2Config cfg;
    cfg.endpoint       = "https://x.r2.cloudflarestorage.com";
    cfg.access_key_id  = "KEY";
    cfg.secret_key     = "SECRET";
    cfg.bucket         = "bucket";
    EXPECT_THROW(load_model_from_r2(cfg, {}), std::runtime_error);
}

TEST(LoadModelFromR2Test, MissingEndpointThrowsDescriptiveError) {
    unsetenv("PATTER_R2_ENDPOINT");
    unsetenv("PATTER_R2_ACCESS_KEY_ID");
    unsetenv("PATTER_R2_BUCKET");

    R2Config cfg; // all empty — should fall through to env vars (also empty)
    try {
        load_model_from_r2(cfg, {"shard0"});
        FAIL() << "Expected runtime_error for missing credentials";
    } catch (const std::runtime_error& e) {
        std::string msg = e.what();
        EXPECT_TRUE(
            msg.find("PATTER_R2_ENDPOINT") != std::string::npos ||
            msg.find("endpoint") != std::string::npos
        ) << "Unexpected error: " << msg;
    }
}

TEST(LoadModelFromR2Test, MissingBucketThrowsDescriptiveError) {
    unsetenv("PATTER_R2_BUCKET");

    R2Config cfg;
    cfg.endpoint      = "https://x.r2.cloudflarestorage.com";
    cfg.access_key_id = "KEY";
    cfg.secret_key    = "SECRET";
    // cfg.bucket intentionally empty

    try {
        load_model_from_r2(cfg, {"shard0"});
        FAIL() << "Expected runtime_error for missing bucket";
    } catch (const std::runtime_error& e) {
        std::string msg = e.what();
        EXPECT_NE(msg.find("bucket"), std::string::npos) << "Got: " << msg;
    }
}

// ── Integration test (skipped unless PATTER_R2_INTEGRATION=1) ────────────────

TEST(LoadModelFromR2Test, DISABLED_IntegrationDownloadsSingleShard) {
    // Run with: PATTER_R2_INTEGRATION=1 ./patter-inference-tests
    const char* flag = std::getenv("PATTER_R2_INTEGRATION");
    if (!flag || std::string(flag) != "1") {
        GTEST_SKIP() << "Set PATTER_R2_INTEGRATION=1 to run this test";
    }

    R2Config cfg;
    // Credentials read from env by load_model_from_r2
    auto data = load_model_from_r2(cfg, {"models/test-shard.onnx.zst.aa"});
    EXPECT_GT(data.size(), 0UL);
}
