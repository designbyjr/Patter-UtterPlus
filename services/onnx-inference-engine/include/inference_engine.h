#pragma once
/**
 * InferenceEngine — shared ONNX sessions with zero-copy audio tensor dispatch.
 *
 * Architecture:
 *  - ONE Ort::Session per model is created at boot time from the in-RAM model buffer.
 *  - The session is shared read-only across all 15 concurrent call threads.
 *    ONNX Runtime's Run() method is thread-safe — weight reads are concurrent, and
 *    per-call intermediate activations are allocated on the thread-local ORT arena.
 *  - Audio PCM frames are passed as Ort::Value tensors that reference the caller's
 *    float buffer directly (no copy). The tensor lifetime is scoped to the Run() call.
 *
 * Memory layout per active call (on the stack / thread-local arena):
 *   [ float ring_buffer[11200] ]  — 700ms sliding window @ 16kHz  (43.75 KB)
 *   [ Ort::Value input_tensor  ]  — wraps ring_buffer, no heap alloc
 *   [ Ort::Value output_tensor ]  — ORT allocates on its own arena, freed after Run()
 *
 * Thread safety:
 *  - vad_session_ and eos_session_ are constructed once and then read-only.
 *    std::shared_ptr read is safe from multiple threads after construction.
 *  - run_vad() and run_eos() are const and contain no shared mutable state.
 */

#include <cstddef>
#include <memory>
#include <span>
#include <vector>

// Forward-declare ORT types to avoid pulling the heavy header into every TU
namespace Ort { class Session; class Env; class SessionOptions; }

namespace patter {

/** Inference results for a single 20ms audio frame. */
struct FrameResult {
    float vad_score = 0.f;   ///< TenVAD speech probability [0, 1]
    float eos_score = 0.f;   ///< Wav2Vec2 EOS probability  [0, 1]
    bool  has_eos   = false; ///< true if EOS session is loaded
};

class InferenceEngine {
public:
    /**
     * Construct the engine and load both ONNX sessions from in-RAM buffers.
     *
     * @param vad_model_bytes   Decompressed TenVAD ONNX flatbuffer (move-in).
     * @param eos_model_bytes   Decompressed Wav2Vec2EOS ONNX flatbuffer (move-in).
     *                          Pass an empty vector to skip EOS loading.
     * @param num_threads       ORT intra-op thread count (default 1 per-session;
     *                          parallelism comes from 15 concurrent callers, not ORT).
     */
    explicit InferenceEngine(
        std::vector<char> vad_model_bytes,
        std::vector<char> eos_model_bytes = {},
        int               num_threads = 1
    );

    ~InferenceEngine();

    // Non-copyable; ownership is clear.
    InferenceEngine(const InferenceEngine&)            = delete;
    InferenceEngine& operator=(const InferenceEngine&) = delete;

    /**
     * Run VAD inference on a single 512-sample (32ms) audio frame.
     *
     * Zero-copy: pcm_frame must remain valid for the duration of the call.
     * Thread-safe: multiple calls may run concurrently from different threads.
     *
     * @param pcm_frame  Float32 samples, exactly 512 elements, normalised [-1, 1].
     * @param rnn_state  In/out RNN hidden state (2×1×128). Caller owns; must not be
     *                   shared between concurrent calls for the same logical session.
     * @return VAD probability in [0, 1].
     */
    float run_vad(
        std::span<const float> pcm_frame,
        std::span<float>       rnn_state
    ) const;

    /**
     * Run Wav2Vec2 EOS inference on a 700ms PCM window (11,200 samples).
     *
     * Zero-copy: window must remain valid for the duration of the call.
     * Thread-safe: shares the single eos_session_ (read-only weights).
     *
     * @param window  Float32 samples, exactly 11200 elements, normalised [-1, 1].
     * @return EOS probability in [0, 1], or 0.0 if EOS session not loaded.
     */
    float run_eos(std::span<const float> window) const;

    /** Result of Wav2Vec2 Speech Emotion Recognition inference. */
    struct EmotionResult {
        std::string emotion = "neutral";
        float score = 0.0f;
    };

    /**
     * Run Wav2Vec2 Speech Emotion Recognition on 16kHz float32 audio waveform.
     * Unlike text models using int64_t tokens, this takes raw float32 samples [-1, 1]
     * sampled strictly at 16,000 Hz.
     *
     * @param pcm_16khz Float32 audio samples @ 16kHz.
     */
    EmotionResult run_emotion(std::span<const float> pcm_16khz) const;

    bool has_vad_session() const noexcept { return vad_session_ != nullptr; }
    bool has_eos_session() const noexcept { return eos_session_ != nullptr; }
    bool has_emotion_session() const noexcept { return emotion_session_ != nullptr; }

private:
    // Shared across threads — constructed once, then read-only.
    std::shared_ptr<Ort::Env>            ort_env_;
    std::shared_ptr<Ort::Session>        vad_session_;
    std::shared_ptr<Ort::Session>        eos_session_;
    std::shared_ptr<Ort::Session>        emotion_session_;

    // Model buffers kept alive so ORT can page weight data on demand.
    std::vector<char> vad_model_bytes_;
    std::vector<char> eos_model_bytes_;
    std::vector<char> emotion_model_bytes_;
};

/**
 * Per-connection audio state. NOT thread-safe; one instance per active call.
 *
 * Manages the 700ms ring buffer and RNN state for a single caller.
 */
class CallAudioState {
public:
    static constexpr int SAMPLE_RATE   = 16000;
    static constexpr int FRAME_SAMPLES = 512;           // 32ms TenVAD frame
    static constexpr int EOS_WINDOW    = 11200;         // 700ms Wav2Vec2 window
    static constexpr int RNN_SIZE      = 2 * 1 * 128;  // TenVAD RNN hidden

    CallAudioState();

    /**
     * Ingest a 20ms PCM fragment (int16 LE) from the Telnyx WebSocket frame.
     * Converts to float32 and appends to the ring buffer.
     *
     * @param pcm16  Raw int16 LE bytes from the WebSocket binary frame.
     * @param len    Byte length of pcm16 (must be even).
     */
    void push_pcm16(const char* pcm16, std::size_t len);

    /**
     * True when enough samples have accumulated for a VAD frame (>=512 samples).
     */
    bool has_vad_frame() const noexcept;

    /**
     * Consume one 512-sample VAD frame (oldest samples first).
     * Caller must check has_vad_frame() first.
     */
    std::span<const float> consume_vad_frame();

    /**
     * View the most recent 11,200 samples for EOS inference.
     * Returns a shorter span if the buffer is not yet full.
     */
    std::span<const float> eos_window() const noexcept;

    /**
     * In/out RNN state for TenVAD. Caller passes this to InferenceEngine::run_vad().
     */
    std::span<float> rnn_state() noexcept {
        return { rnn_buf_.data(), rnn_buf_.size() };
    }

private:
    // Ring buffer: holds up to EOS_WINDOW samples of the most recent audio.
    // Written as a deque (push_back, pop_front on VAD frame consumption).
    std::vector<float> ring_;
    std::size_t        head_ = 0;  // index of oldest sample in ring_
    std::size_t        count_ = 0; // number of valid samples

    std::vector<float> rnn_buf_;   // TenVAD RNN hidden state (2*1*128)
    std::vector<float> vad_frame_scratch_; // scratch for consume_vad_frame()
};

}  // namespace patter
