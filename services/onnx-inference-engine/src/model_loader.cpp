/**
 * model_loader.cpp — parallel R2 shard download + in-RAM Zstd decompression.
 *
 * Memory safety audit:
 *  - ZSTD_getFrameContentSize() result is validated for ZSTD_CONTENTSIZE_ERROR
 *    and ZSTD_CONTENTSIZE_UNKNOWN before any allocation.
 *  - All buffers owned by std::vector<char>; no raw new/delete.
 *  - libcurl multi-handle is cleaned up in a RAII wrapper (CurlMultiHandle).
 *  - Per-shard easy handles are cleaned up on both success and error paths.
 *  - HTTP response codes are checked; non-2xx throws std::runtime_error.
 */

#include "model_loader.h"

#include <algorithm>
#include <cstring>
#include <format>
#include <stdexcept>
#include <filesystem>
#include <fstream>
#include <vector>


#include <curl/curl.h>
#include <zstd.h>

namespace patter {

// ── libcurl RAII wrappers ──────────────────────────────────────────────────────

namespace {

// Write callback appends bytes into a std::vector<char>*.
size_t curl_write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) noexcept {
    auto* buf = static_cast<std::vector<char>*>(userdata);
    try {
        buf->insert(buf->end(), ptr, ptr + size * nmemb);
        return size * nmemb;
    } catch (...) {
        return 0; // signals error to libcurl
    }
}

// RAII wrapper for CURLM* (multi-handle).
struct CurlMultiHandle {
    CURLM* handle = curl_multi_init();
    ~CurlMultiHandle() {
        if (handle) curl_multi_cleanup(handle);
    }
    explicit operator bool() const noexcept { return handle != nullptr; }
};

// RAII wrapper for a single CURL* easy handle.
struct CurlEasyHandle {
    CURL* handle = curl_easy_init();
    ~CurlEasyHandle() {
        if (handle) curl_easy_cleanup(handle);
    }
    explicit operator bool() const noexcept { return handle != nullptr; }
};

/** Construct the Authorization header for AWS Signature v4 (simplified).
 *  In production, a real SigV4 implementation or a pre-signed URL should be used.
 *  For R2 public-bucket or service-token auth, a bearer token is sufficient.
 *  This stub inserts the access key as a placeholder — replace with full SigV4. */
std::string make_auth_header(const std::string& access_key_id) {
    return "Authorization: AWS4-HMAC-SHA256 Credential=" + access_key_id;
}

/** Build the full R2 object URL for a given shard key. */
std::string make_shard_url(
    const std::string& endpoint,
    const std::string& bucket,
    const std::string& key
) {
    // endpoint = https://account.r2.cloudflarestorage.com
    // url      = https://account.r2.cloudflarestorage.com/bucket/key
    return endpoint + "/" + bucket + "/" + key;
}

}  // namespace

// ── zstd_decompress ────────────────────────────────────────────────────────────

std::vector<char> zstd_decompress(const std::vector<char>& compressed) {
    if (compressed.empty()) {
        throw std::runtime_error("zstd_decompress: input buffer is empty");
    }

    // ── Step 1: determine the exact decompressed size ─────────────────────────
    unsigned long long const frame_size = ZSTD_getFrameContentSize(
        compressed.data(), compressed.size()
    );

    if (frame_size == ZSTD_CONTENTSIZE_ERROR) {
        throw std::runtime_error(
            "zstd_decompress: not a valid zstd frame "
            "(ZSTD_CONTENTSIZE_ERROR). Data may be corrupt or from a different compressor."
        );
    }
    if (frame_size == ZSTD_CONTENTSIZE_UNKNOWN) {
        throw std::runtime_error(
            "zstd_decompress: decompressed size is unknown (ZSTD_CONTENTSIZE_UNKNOWN). "
            "Please compress with zstd --content-size (the default). "
            "Streaming decompression is not supported."
        );
    }
    if (frame_size == 0) {
        // Valid zstd frame of zero bytes — return empty vector.
        return {};
    }

    // ── Step 2: allocate exactly the required destination block ───────────────
    // This is the only allocation; no temporary copies, no over-allocation.
    std::vector<char> output(static_cast<std::size_t>(frame_size));

    // ── Step 3: decompress entirely in RAM — no disk I/O ──────────────────────
    std::size_t const result = ZSTD_decompress(
        output.data(), output.size(),
        compressed.data(), compressed.size()
    );

    if (ZSTD_isError(result)) {
        throw std::runtime_error(
            std::string("zstd_decompress: ZSTD_decompress failed: ") +
            ZSTD_getErrorName(result)
        );
    }
    if (result != static_cast<std::size_t>(frame_size)) {
        // Sanity check: decompressed bytes must match the declared frame size.
        throw std::runtime_error(
            "zstd_decompress: decompressed size mismatch — expected " +
            std::to_string(frame_size) + " bytes, got " + std::to_string(result)
        );
    }

    return output; // NRVO — no copy on return
}

// ── load_model_from_r2 ─────────────────────────────────────────────────────────

std::vector<char> load_model_from_r2(
    const R2Config&                 cfg,
    const std::vector<std::string>& shard_keys
) {
    if (shard_keys.empty()) {
        throw std::runtime_error("load_model_from_r2: shard_keys must be non-empty");
    }

    // Resolve credentials: explicit config > env vars
    const std::string endpoint  = cfg.endpoint.empty()
        ? (std::getenv("PATTER_R2_ENDPOINT")       ? std::getenv("PATTER_R2_ENDPOINT")       : "")
        : cfg.endpoint;
    const std::string ak_id     = cfg.access_key_id.empty()
        ? (std::getenv("PATTER_R2_ACCESS_KEY_ID")  ? std::getenv("PATTER_R2_ACCESS_KEY_ID")  : "")
        : cfg.access_key_id;
    const std::string bucket    = cfg.bucket.empty()
        ? (std::getenv("PATTER_R2_BUCKET")         ? std::getenv("PATTER_R2_BUCKET")         : "")
        : cfg.bucket;

    if (endpoint.empty()) throw std::runtime_error("load_model_from_r2: R2 endpoint is required (PATTER_R2_ENDPOINT)");
    if (ak_id.empty())    throw std::runtime_error("load_model_from_r2: R2 access key is required (PATTER_R2_ACCESS_KEY_ID)");
    if (bucket.empty())   throw std::runtime_error("load_model_from_r2: R2 bucket is required (PATTER_R2_BUCKET)");

    int default_concurrency = 8;
    if (const char* env_c = std::getenv("PATTER_SHARD_CONCURRENCY")) {
        default_concurrency = std::atoi(env_c);
    }
    const int concurrency = std::max(1, cfg.concurrency > 0 ? cfg.concurrency : default_concurrency);
    const long timeout_ms  = cfg.timeout_ms > 0 ? cfg.timeout_ms : 10000L;

    const int N = static_cast<int>(shard_keys.size());

    // Per-shard download buffers — indexed by shard position
    std::vector<std::vector<char>> shard_buffers(N);

    // ── Parallel download via curl_multi ──────────────────────────────────────
    CurlMultiHandle multi;
    if (!multi) {
        throw std::runtime_error("load_model_from_r2: curl_multi_init() failed");
    }

    std::string auth_header = make_auth_header(ak_id);

    // We process shards in batches of `concurrency` to cap in-flight requests.
    int shard_index = 0;
    while (shard_index < N) {
        const int batch_end = std::min(shard_index + concurrency, N);

        // Allocate one easy handle per shard in this batch
        std::vector<CurlEasyHandle> easy_handles(batch_end - shard_index);
        std::vector<curl_slist*>    header_lists(batch_end - shard_index, nullptr);

        for (int i = shard_index; i < batch_end; ++i) {
            const int bi = i - shard_index;
            CurlEasyHandle& eh = easy_handles[bi];
            if (!eh) throw std::runtime_error("curl_easy_init() failed for shard " + std::to_string(i));

            const std::string url = make_shard_url(endpoint, bucket, shard_keys[i]);

            curl_slist* headers = curl_slist_append(nullptr, auth_header.c_str());
            header_lists[bi] = headers;

            curl_easy_setopt(eh.handle, CURLOPT_URL,            url.c_str());
            curl_easy_setopt(eh.handle, CURLOPT_HTTPHEADER,     headers);
            curl_easy_setopt(eh.handle, CURLOPT_WRITEFUNCTION,  curl_write_cb);
            curl_easy_setopt(eh.handle, CURLOPT_WRITEDATA,      &shard_buffers[i]);
            curl_easy_setopt(eh.handle, CURLOPT_TIMEOUT_MS,     timeout_ms);
            curl_easy_setopt(eh.handle, CURLOPT_FOLLOWLOCATION, 1L);
            curl_easy_setopt(eh.handle, CURLOPT_FAILONERROR,    1L); // 4xx/5xx → error
            curl_easy_setopt(eh.handle, CURLOPT_PRIVATE,        reinterpret_cast<void*>(static_cast<uintptr_t>(i)));

            curl_multi_add_handle(multi.handle, eh.handle);
        }

        // Run the multi event loop until all handles in this batch complete
        int still_running = 0;
        do {
            CURLMcode mc = curl_multi_perform(multi.handle, &still_running);
            if (mc != CURLM_OK) {
                // Cleanup header lists before throwing
                for (auto* hl : header_lists) if (hl) curl_slist_free_all(hl);
                throw std::runtime_error(
                    std::string("curl_multi_perform error: ") + curl_multi_strerror(mc)
                );
            }
            if (still_running) {
                curl_multi_wait(multi.handle, nullptr, 0, 50 /*ms*/, nullptr);
            }
        } while (still_running > 0);

        // Check each handle for HTTP errors
        CURLMsg* msg;
        int msgs_left = 0;
        while ((msg = curl_multi_info_read(multi.handle, &msgs_left)) != nullptr) {
            if (msg->msg == CURLMSG_DONE) {
                CURL* eh_ptr = msg->easy_handle;
                if (msg->data.result != CURLE_OK) {
                    for (auto* hl : header_lists) if (hl) curl_slist_free_all(hl);
                    throw std::runtime_error(
                        std::string("R2 shard download failed: ") +
                        curl_easy_strerror(msg->data.result)
                    );
                }
                long http_code = 0;
                curl_easy_getinfo(eh_ptr, CURLINFO_RESPONSE_CODE, &http_code);
                if (http_code < 200 || http_code >= 300) {
                    for (auto* hl : header_lists) if (hl) curl_slist_free_all(hl);
                    throw std::runtime_error(
                        "R2 shard returned HTTP " + std::to_string(http_code)
                    );
                }
                curl_multi_remove_handle(multi.handle, eh_ptr);
            }
        }

        // Cleanup header lists for this batch
        for (auto* hl : header_lists) if (hl) curl_slist_free_all(hl);

        shard_index = batch_end;
    }

    // ── Assemble shards in order into one contiguous buffer ───────────────────
    std::size_t total_size = 0;
    for (const auto& buf : shard_buffers) total_size += buf.size();

    std::vector<char> assembled;
    assembled.reserve(total_size);
    for (auto& buf : shard_buffers) {
        assembled.insert(assembled.end(), buf.begin(), buf.end());
        buf.clear();       // free shard buffer immediately to minimise peak RAM
        buf.shrink_to_fit();
    }

    // ── Decompress in-place ───────────────────────────────────────────────────
    return zstd_decompress(assembled);
}

std::string download_and_extract_model_to_disk(
    const R2Config&                 cfg,
    const std::vector<std::string>& shard_keys,
    const std::string&              model_key
) {
    namespace fs = std::filesystem;
    std::string perm_dir = "/var/cache/patter-models";
    std::error_code ec;
    fs::create_directories(perm_dir, ec);
    if (ec) {
        perm_dir = "/tmp/patter-models";
        fs::create_directories(perm_dir, ec);
    }

    std::string final_path = perm_dir + "/" + model_key + ".onnx";
    if (fs::exists(final_path)) {
        return final_path;
    }

    std::string scratch_dir = "/tmp/patter-models/scratch";
    fs::create_directories(scratch_dir, ec);
    std::string tmp_path = scratch_dir + "/" + model_key + ".tmp";

    // Fast C++ parallel download + zstd decompression
    std::vector<char> decompressed = load_model_from_r2(cfg, shard_keys);

    // Write to temporary scratch file
    std::ofstream out(tmp_path, std::ios::binary);
    if (!out) {
        throw std::runtime_error("Failed to open scratch file for writing: " + tmp_path);
    }
    out.write(decompressed.data(), decompressed.size());
    out.close();

    // Atomic move from /tmp/scratch to final permanent directory
    fs::rename(tmp_path, final_path, ec);
    if (ec) {
        fs::copy_file(tmp_path, final_path, fs::copy_options::overwrite_existing, ec);
        fs::remove(tmp_path, ec);
    }

    return final_path;
}
}

std::string load_model_to_file_atomic(
    const R2Config&                 cfg,
    const std::vector<std::string>& shard_keys,
    const std::string&              model_key,
    const std::string&              target_dir
) {
    namespace fs = std::filesystem;
    fs::path perm_dir(target_dir.empty() ? "/var/cache/patter-models" : target_dir);
    fs::path final_path = perm_dir / (model_key + ".onnx");

    if (fs::exists(final_path) && fs::file_size(final_path) > 0) {
        return final_path.string();
    }

    // Step 1: Parallel download & decompress in RAM via C++ libcurl + libzstd
    std::vector<char> decompressed = load_model_from_r2(cfg, shard_keys);

    // Step 2: Write to temporary file in /tmp/patter-models/tmp_download/
    fs::path tmp_dir = "/tmp/patter-models/tmp_download";
    fs::create_directories(tmp_dir);
    fs::path tmp_file = tmp_dir / (model_key + "_" + std::to_string(std::time(nullptr)) + ".tmp");

    std::ofstream out(tmp_file, std::ios::binary);
    if (!out) {
        throw std::runtime_error("Failed to open temporary file for writing: " + tmp_file.string());
    }
    out.write(decompressed.data(), decompressed.size());
    out.close();

    // Step 3: Atomically move/rename to permanent target directory
    fs::create_directories(perm_dir);
    fs::rename(tmp_file, final_path);

    return final_path.string();
}

}  // namespace patter

