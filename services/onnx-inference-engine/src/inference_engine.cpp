#include "inference_engine.h"
#include <onnxruntime_cxx_api.h>
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <cstring>

namespace patter {

InferenceEngine::InferenceEngine(
    std::vector<char> vad_model_bytes,
    std::vector<char> eos_model_bytes,
    int               num_threads
) : vad_model_bytes_(std::move(vad_model_bytes)),
    eos_model_bytes_(std::move(eos_model_bytes))
{
    ort_env_ = std::make_shared<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "PatterEngine");

    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(num_threads);
    opts.SetInterOpNumThreads(1);
    opts.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    if (!vad_model_bytes_.empty()) {
        try {
            vad_session_ = std::make_shared<Ort::Session>(
                *ort_env_,
                vad_model_bytes_.data(),
                vad_model_bytes_.size(),
                opts
            );
        } catch (const std::exception& e) {
            // Log fallback if needed
        }
    }

    if (!eos_model_bytes_.empty()) {
        try {
            eos_session_ = std::make_shared<Ort::Session>(
                *ort_env_,
                eos_model_bytes_.data(),
                eos_model_bytes_.size(),
                opts
            );
        } catch (const std::exception& e) {
            // Log fallback if needed
        }
    }
}

InferenceEngine::~InferenceEngine() = default;

float InferenceEngine::run_vad(
    std::span<const float> pcm_frame,
    std::span<float>       rnn_state
) const {
    if (!vad_session_) {
        // Acoustic fallback calculation: RMS dBFS normalization
        float sum_sq = 0.f;
        for (float s : pcm_frame) {
            sum_sq += s * s;
        }
        float rms = std::sqrt(sum_sq / std::max<std::size_t>(1, pcm_frame.size()));
        float dbfs = (rms > 1e-6f) ? 20.f * std::log10(rms) : -60.f;
        if (dbfs <= -45.f) return 0.0f;
        if (dbfs >= -15.f) return 1.0f;
        return (dbfs - (-45.f)) / (-15.f - (-45.f));
    }

    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(
        OrtAllocatorType::OrtArenaAllocator, OrtMemType::OrtMemTypeDefault
    );

    std::array<int64_t, 2> input_shape{1, static_cast<int64_t>(pcm_frame.size())};
    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        memory_info,
        const_cast<float*>(pcm_frame.data()),
        pcm_frame.size(),
        input_shape.data(),
        input_shape.size()
    );

    std::array<int64_t, 3> state_shape{2, 1, 128};
    Ort::Value state_tensor = Ort::Value::CreateTensor<float>(
        memory_info,
        rnn_state.data(),
        rnn_state.size(),
        state_shape.data(),
        state_shape.size()
    );

    const char* input_names[] = {"input", "state"};
    Ort::Value inputs[] = {std::move(input_tensor), std::move(state_tensor)};
    const char* output_names[] = {"output", "stateN"};

    auto outputs = vad_session_->Run(
        Ort::RunOptions{nullptr},
        input_names,
        inputs,
        2,
        output_names,
        1
    );

    float* out_data = outputs[0].GetTensorMutableData<float>();
    return out_data ? out_data[0] : 0.0f;
}

float InferenceEngine::run_eos(std::span<const float> window) const {
    if (!eos_session_) {
        // Acoustic fallback: trailing pitch decay vs preceding speech RMS energy
        if (window.size() < 320) return 0.0f;
        std::size_t recent_count = std::min<std::size_t>(3200, window.size());
        float recent_sum_sq = 0.f;
        for (std::size_t i = window.size() - recent_count; i < window.size(); ++i) {
            recent_sum_sq += window[i] * window[i];
        }
        float recent_rms = std::sqrt(recent_sum_sq / recent_count);

        std::size_t prior_count = std::min<std::size_t>(8000, window.size() - recent_count);
        if (prior_count > 0) {
            float prior_sum_sq = 0.f;
            for (std::size_t i = window.size() - recent_count - prior_count; i < window.size() - recent_count; ++i) {
                prior_sum_sq += window[i] * window[i];
            }
            float prior_rms = std::sqrt(prior_sum_sq / prior_count);
            float decay_ratio = (prior_rms > 0.f) ? (recent_rms / prior_rms) : 0.f;
            if (decay_ratio < 0.25f) return 0.88f;
            if (decay_ratio < 0.45f) return 0.72f;
        }

        return (recent_rms < 0.01f) ? 0.85f : 0.2f;
    }

    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(
        OrtAllocatorType::OrtArenaAllocator, OrtMemType::OrtMemTypeDefault
    );

    std::array<int64_t, 2> input_shape{1, static_cast<int64_t>(window.size())};
    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        memory_info,
        const_cast<float*>(window.data()),
        window.size(),
        input_shape.data(),
        input_shape.size()
    );

    const char* input_names[] = {"input_values"};
    Ort::Value inputs[] = {std::move(input_tensor)};
    const char* output_names[] = {"logits"};

    auto outputs = eos_session_->Run(
        Ort::RunOptions{nullptr},
        input_names,
        inputs,
        1,
        output_names,
        1
    );

    float* out_data = outputs[0].GetTensorMutableData<float>();
    if (!out_data) return 0.0f;
    float raw_score = out_data[0];
    return 1.0f / (1.0f + std::exp(-raw_score)); // Sigmoid
}

InferenceEngine::EmotionResult InferenceEngine::run_emotion(std::span<const float> pcm_16khz) const {
    if (pcm_16khz.empty()) return {"neutral", 0.85f};

    static const std::vector<std::string> labels = {"angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"};

    if (!emotion_session_) {
        // Fallback heuristic based on RMS audio energy
        float sum_sq = 0.f;
        for (float s : pcm_16khz) sum_sq += s * s;
        float rms = std::sqrt(sum_sq / static_cast<float>(pcm_16khz.size()));
        return (rms > 0.15f) ? EmotionResult{"angry", 0.65f} : EmotionResult{"neutral", 0.85f};
    }

    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(
        OrtAllocatorType::OrtArenaAllocator, OrtMemType::OrtMemTypeDefault
    );

    // Unlike text models taking int64_t tokens, raw audio expects float32 waveforms [1, N_samples] @ 16kHz
    std::array<int64_t, 2> input_shape{1, static_cast<int64_t>(pcm_16khz.size())};
    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        memory_info,
        const_cast<float*>(pcm_16khz.data()),
        pcm_16khz.size(),
        input_shape.data(),
        input_shape.size()
    );

    const char* input_names[] = {"input_values"};
    Ort::Value inputs[] = {std::move(input_tensor)};
    const char* output_names[] = {"logits"};

    auto outputs = emotion_session_->Run(
        Ort::RunOptions{nullptr},
        input_names,
        inputs,
        1,
        output_names,
        1
    );

    float* logits = outputs[0].GetTensorMutableData<float>();
    if (!logits) return {"neutral", 0.85f};

    // Find max logit (argmax)
    int max_idx = 0;
    float max_val = logits[0];
    for (int i = 1; i < 7; ++i) {
        if (logits[i] > max_val) {
            max_val = logits[i];
            max_idx = i;
        }
    }

    return EmotionResult{labels[max_idx], max_val};
}

CallAudioState::CallAudioState() {
    rnn_buf_.resize(RNN_SIZE, 0.0f);
    ring_.reserve(EOS_WINDOW);
}

void CallAudioState::push_pcm16(const char* pcm16, std::size_t len) {
    std::size_t num_samples = len / 2;
    const auto* i16 = reinterpret_cast<const int16_t*>(pcm16);
    for (std::size_t i = 0; i < num_samples; ++i) {
        float s = static_cast<float>(i16[i]) / 32768.0f;
        if (ring_.size() >= EOS_WINDOW) {
            ring_.erase(ring_.begin());
        }
        ring_.push_back(s);
    }
}

bool CallAudioState::has_vad_frame() const noexcept {
    return ring_.size() >= FRAME_SAMPLES;
}

std::span<const float> CallAudioState::consume_vad_frame() {
    if (ring_.size() < FRAME_SAMPLES) return {};
    vad_frame_scratch_.assign(ring_.begin(), ring_.begin() + FRAME_SAMPLES);
    return { vad_frame_scratch_.data(), vad_frame_scratch_.size() };
}

std::span<const float> CallAudioState::eos_window() const noexcept {
    return { ring_.data(), ring_.size() };
}

} // namespace patter
