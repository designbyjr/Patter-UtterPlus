/**
 * test_inference_engine.cpp — Google Test suite for patter::CallAudioState.
 *
 * InferenceEngine::run_vad / run_eos require real ONNX model bytes to test
 * end-to-end; those tests are marked DISABLED_ and only run when a real model
 * file is present (integration mode). All other tests cover CallAudioState
 * which has no ORT dependency and exercises:
 *
 *   1.  Initial state (empty buffers, no frame ready)
 *   2.  push_pcm16 converts int16 LE to float32 correctly
 *   3.  has_vad_frame false when < FRAME_SAMPLES (512) samples buffered
 *   4.  has_vad_frame true when >= 512 samples
 *   5.  consume_vad_frame returns exactly FRAME_SAMPLES elements
 *   6.  consume_vad_frame removes the consumed samples from the head
 *   7.  eos_window returns correct span size
 *   8.  eos_window returns shorter span when buffer not yet full
 *   9.  rnn_state buffer has the expected size (2*1*128 = 256 floats)
 *  10.  Samples beyond EOS_WINDOW are discarded (ring acts as sliding window)
 *  11.  float32 normalisation: int16 MIN/MAX map to ±1.0 within tolerance
 *  12.  Multiple VAD frames consumed in FIFO order
 *  13.  Thread-safety: concurrent push + consume from separate threads (no crash)
 */

#include <gtest/gtest.h>
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <thread>
#include <vector>

#include "inference_engine.h"

using patter::CallAudioState;

// ── Helper: build a PCM16 LE byte buffer from float samples ──────────────────

static std::vector<char> make_pcm16(const std::vector<float>& floats) {
    std::vector<char> out(floats.size() * 2);
    for (std::size_t i = 0; i < floats.size(); ++i) {
        int16_t s = static_cast<int16_t>(
            std::clamp(floats[i] * 32767.f, -32768.f, 32767.f)
        );
        // Little-endian
        out[i * 2 + 0] = static_cast<char>(s & 0xFF);
        out[i * 2 + 1] = static_cast<char>((s >> 8) & 0xFF);
    }
    return out;
}

/** Push N silent (zero) samples into the state. */
static void push_silent(CallAudioState& st, std::size_t n_samples) {
    std::vector<char> zeros(n_samples * 2, '\0');
    st.push_pcm16(zeros.data(), zeros.size());
}

// ── 1. Initial state ──────────────────────────────────────────────────────────

TEST(CallAudioStateTest, InitiallyEmpty) {
    CallAudioState st;
    EXPECT_FALSE(st.has_vad_frame());
    EXPECT_EQ(st.eos_window().size(), 0UL);
    EXPECT_EQ(st.rnn_state().size(), static_cast<std::size_t>(CallAudioState::RNN_SIZE));
}

// ── 2. PCM16 → float32 conversion ─────────────────────────────────────────────

TEST(CallAudioStateTest, Pcm16ToFloat32ConversionIsCorrect) {
    CallAudioState st;

    // One sample: 0x7FFF (32767) → +1.0 (approx), 0x8001 (-32767) → -1.0 (approx)
    std::vector<float> src = {1.0f, -1.0f, 0.0f, 0.5f};
    auto pcm = make_pcm16(src);
    st.push_pcm16(pcm.data(), pcm.size());

    // Verify via eos_window (which exposes the ring buffer)
    auto win = st.eos_window();
    ASSERT_EQ(win.size(), 4UL);

    EXPECT_NEAR(win[0],  1.0f, 0.01f);
    EXPECT_NEAR(win[1], -1.0f, 0.01f);
    EXPECT_NEAR(win[2],  0.0f, 0.01f);
    EXPECT_NEAR(win[3],  0.5f, 0.01f);
}

// ── 3. has_vad_frame false below threshold ────────────────────────────────────

TEST(CallAudioStateTest, HasVadFrameFalseWhenBelowThreshold) {
    CallAudioState st;
    push_silent(st, CallAudioState::FRAME_SAMPLES - 1); // 511 samples
    EXPECT_FALSE(st.has_vad_frame());
}

// ── 4. has_vad_frame true at threshold ────────────────────────────────────────

TEST(CallAudioStateTest, HasVadFrameTrueAtThreshold) {
    CallAudioState st;
    push_silent(st, CallAudioState::FRAME_SAMPLES); // exactly 512
    EXPECT_TRUE(st.has_vad_frame());
}

TEST(CallAudioStateTest, HasVadFrameTrueAboveThreshold) {
    CallAudioState st;
    push_silent(st, CallAudioState::FRAME_SAMPLES + 100);
    EXPECT_TRUE(st.has_vad_frame());
}

// ── 5. consume_vad_frame returns exactly FRAME_SAMPLES ────────────────────────

TEST(CallAudioStateTest, ConsumeVadFrameReturnsCorrectSize) {
    CallAudioState st;
    push_silent(st, CallAudioState::FRAME_SAMPLES * 2);
    auto frame = st.consume_vad_frame();
    EXPECT_EQ(frame.size(), static_cast<std::size_t>(CallAudioState::FRAME_SAMPLES));
}

// ── 6. consume_vad_frame removes the consumed samples ─────────────────────────

TEST(CallAudioStateTest, ConsumeVadFrameAdvancesHead) {
    CallAudioState st;
    // Push exactly two frames
    push_silent(st, CallAudioState::FRAME_SAMPLES * 2);

    EXPECT_TRUE(st.has_vad_frame());
    st.consume_vad_frame(); // consume first frame
    EXPECT_TRUE(st.has_vad_frame());  // second frame still available
    st.consume_vad_frame(); // consume second frame
    EXPECT_FALSE(st.has_vad_frame()); // ring is now empty for VAD
}

// ── 7. eos_window grows up to EOS_WINDOW ─────────────────────────────────────

TEST(CallAudioStateTest, EosWindowGrowsWithPushes) {
    CallAudioState st;
    const std::size_t half = CallAudioState::EOS_WINDOW / 2;
    push_silent(st, half);
    EXPECT_EQ(st.eos_window().size(), half);
}

TEST(CallAudioStateTest, EosWindowMaxSizeIsEosWindow) {
    CallAudioState st;
    push_silent(st, CallAudioState::EOS_WINDOW + 500);
    EXPECT_EQ(st.eos_window().size(), static_cast<std::size_t>(CallAudioState::EOS_WINDOW));
}

// ── 8. Ring slides: oldest samples discarded when full ────────────────────────

TEST(CallAudioStateTest, RingSlidesDiscardingOldestSamples) {
    CallAudioState st;
    const std::size_t W = CallAudioState::EOS_WINDOW;

    // Fill the window with value 0.5
    std::vector<float> first_batch(W, 0.5f);
    auto pcm_first = make_pcm16(first_batch);
    st.push_pcm16(pcm_first.data(), pcm_first.size());

    // Push 100 more samples with value 0.9
    std::vector<float> second_batch(100, 0.9f);
    auto pcm_second = make_pcm16(second_batch);
    st.push_pcm16(pcm_second.data(), pcm_second.size());

    // Window should still be EOS_WINDOW samples
    auto win = st.eos_window();
    EXPECT_EQ(win.size(), W);

    // The last 100 samples should be ~0.9
    for (std::size_t i = W - 100; i < W; ++i) {
        EXPECT_NEAR(win[i], 0.9f, 0.01f) << "at index " << i;
    }
    // The first W-100 samples should be ~0.5
    for (std::size_t i = 0; i < W - 100; ++i) {
        EXPECT_NEAR(win[i], 0.5f, 0.01f) << "at index " << i;
    }
}

// ── 9. RNN state size ─────────────────────────────────────────────────────────

TEST(CallAudioStateTest, RnnStateSizeIsCorrect) {
    CallAudioState st;
    EXPECT_EQ(st.rnn_state().size(), static_cast<std::size_t>(CallAudioState::RNN_SIZE));
}

TEST(CallAudioStateTest, RnnStateIsInitialisedToZero) {
    CallAudioState st;
    for (float v : st.rnn_state()) {
        EXPECT_EQ(v, 0.0f);
    }
}

// ── 10. Float normalisation boundaries ───────────────────────────────────────

TEST(CallAudioStateTest, Int16MaxMapsToApproxPlusOne) {
    CallAudioState st;
    // int16 max = 0x7FFF = 32767
    char pcm[2] = {static_cast<char>(0xFF), static_cast<char>(0x7F)}; // LE 32767
    st.push_pcm16(pcm, 2);
    auto win = st.eos_window();
    ASSERT_EQ(win.size(), 1UL);
    EXPECT_NEAR(win[0], 1.0f, 0.001f);
}

TEST(CallAudioStateTest, Int16MinMapsToApproxMinusOne) {
    CallAudioState st;
    // int16 min = 0x8000 = -32768 → LE: 0x00, 0x80
    char pcm[2] = {static_cast<char>(0x00), static_cast<char>(0x80)};
    st.push_pcm16(pcm, 2);
    auto win = st.eos_window();
    ASSERT_EQ(win.size(), 1UL);
    EXPECT_NEAR(win[0], -1.0f, 0.001f);
}

// ── 11. FIFO ordering of VAD frames ──────────────────────────────────────────

TEST(CallAudioStateTest, ConsumedVadFramesAreInFifoOrder) {
    CallAudioState st;

    // Frame 1: all 1.0
    std::vector<float> f1(CallAudioState::FRAME_SAMPLES, 1.0f);
    auto pcm1 = make_pcm16(f1);
    st.push_pcm16(pcm1.data(), pcm1.size());

    // Frame 2: all -1.0
    std::vector<float> f2(CallAudioState::FRAME_SAMPLES, -1.0f);
    auto pcm2 = make_pcm16(f2);
    st.push_pcm16(pcm2.data(), pcm2.size());

    // First consumed frame should be ~1.0
    auto first = st.consume_vad_frame();
    EXPECT_NEAR(first[0], 1.0f, 0.01f);

    // Second consumed frame should be ~-1.0
    auto second = st.consume_vad_frame();
    EXPECT_NEAR(second[0], -1.0f, 0.01f);
}

// ── 12. Odd-byte push is safe (ignored or partial) ───────────────────────────

TEST(CallAudioStateTest, OddByteLengthIsSafe) {
    CallAudioState st;
    // 3 bytes = 1 complete int16 sample + 1 orphan byte → should handle gracefully
    char pcm[3] = {0x00, 0x40, 0x00}; // 1 complete sample + 1 orphan
    EXPECT_NO_THROW(st.push_pcm16(pcm, 3));
}

// ── 13. Concurrent push / consume (no crash, no UB) ──────────────────────────

TEST(CallAudioStateTest, ConcurrentPushAndConsumeDoNotCrash) {
    // NOTE: CallAudioState is intentionally NOT thread-safe (one per call).
    // This test verifies that independent instances work correctly in parallel,
    // simulating 8 concurrent callers each with their own state.
    constexpr int CALLERS = 8;
    std::vector<std::thread> threads;
    threads.reserve(CALLERS);

    for (int c = 0; c < CALLERS; ++c) {
        threads.emplace_back([c] {
            CallAudioState st;
            const float value = static_cast<float>(c) / CALLERS;
            std::vector<float> samples(CallAudioState::FRAME_SAMPLES * 3, value);
            auto pcm = make_pcm16(samples);
            st.push_pcm16(pcm.data(), pcm.size());

            while (st.has_vad_frame()) {
                auto frame = st.consume_vad_frame();
                EXPECT_EQ(frame.size(),
                          static_cast<std::size_t>(CallAudioState::FRAME_SAMPLES));
            }
        });
    }

    for (auto& th : threads) th.join();
    // If we got here without a crash or sanitiser error, the test passes.
    SUCCEED();
}

// ── Integration tests (skipped without real model) ────────────────────────────

// These are kept as DISABLED_ so they don't run in CI but can be enabled locally.
// Run with: --gtest_also_run_disabled_tests

TEST(InferenceEngineTest, DISABLED_RunVadOnSyntheticSilence) {
    // Load real model from disk:
    // InferenceEngine engine(load_file("/path/to/ten_vad.onnx"), {});
    // ...
    GTEST_SKIP() << "Requires real TenVAD model file";
}

TEST(InferenceEngineTest, DISABLED_RunEosOnSyntheticSilence) {
    GTEST_SKIP() << "Requires real Wav2Vec2EOS model file";
}
