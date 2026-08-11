"""
Telnyx Wav2Vec2 End-of-Speech (EOS) Provider — ONNX & Acoustic Audio Window Classifier.

Runs a 700ms sliding PCM audio window (11,200 samples @ 16kHz) at 100ms step intervals.
Used as an uncertainty tie-breaker when TurnSense confidence is in the gray-zone [0.45, 0.75],
eliminating the 200ms Cloudflare Deepgram Flux WebSocket latency.
"""

from __future__ import annotations

import math
import os
import struct
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("getpatter")


class TelnyxWav2Vec2EOS:
    provider_key = "telnyx_wav2vec2_eos"

    def __init__(
        self,
        model_path: Optional[str] = None,
        sample_rate: int = 16000,
        window_ms: int = 700,
        threshold: float = 0.80,
    ) -> None:
        self.model_path = model_path
        self.sample_rate = sample_rate
        self.window_ms = window_ms
        self.window_samples = int((window_ms / 1000.0) * sample_rate)
        self.threshold = threshold
        self._session: Any = None
        self._is_loaded = False
        self._init_session()

    @classmethod
    async def load(
        cls,
        model_path: Optional[str] = None,
        sample_rate: int = 16000,
        window_ms: int = 700,
        threshold: float = 0.80,
    ) -> TelnyxWav2Vec2EOS:
        instance = cls(
            model_path=model_path,
            sample_rate=sample_rate,
            window_ms=window_ms,
            threshold=threshold,
        )
        await instance.ensure_loaded()
        return instance

    def _init_session(self) -> None:
        resolved_path = (
            self.model_path
            or os.environ.get("PATTER_TELNYX_EOS_MODEL")
            or os.path.join(
                os.path.dirname(__file__), "..", "resources", "telnyx_wav2vec2_eos_int8.onnx"
            )
        )
        if os.path.exists(resolved_path):
            try:
                import onnxruntime as ort

                opts = ort.SessionOptions()
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                self._session = ort.InferenceSession(resolved_path, opts, providers=["CPUExecutionProvider"])
                logger.info(f"[PATTER] TelnyxWav2Vec2EOS model loaded into memory from: {resolved_path}")
            except Exception as err:
                logger.debug(
                    f"[PATTER] TelnyxWav2Vec2EOS ONNX load fallback: {err}"
                )
        self._is_loaded = True

    async def ensure_loaded(self) -> None:
        if not self._is_loaded:
            self._init_session()

    async def predict_eos(self, pcm_buffer: bytes) -> float:
        await self.ensure_loaded()
        if not pcm_buffer:
            return 0.0

        if self._session is not None:
            try:
                import numpy as np

                num_samples = len(pcm_buffer) // 2
                samples = struct.unpack(f"<{num_samples}h", pcm_buffer[: num_samples * 2])
                float_samples = [s / 32768.0 for s in samples]

                if len(float_samples) < self.window_samples:
                    padded = float_samples + [0.0] * (self.window_samples - len(float_samples))
                else:
                    padded = float_samples[-self.window_samples :]

                input_tensor = np.array([padded], dtype=np.float32)
                input_name = self._session.get_inputs()[0].name
                outputs = self._session.run(None, {input_name: input_tensor})
                logits = outputs[0]
                raw_score = float(logits.flat[0])
                return 1.0 / (1.0 + math.exp(-raw_score))
            except Exception as err:
                logger.debug(
                    f"[PATTER] TelnyxWav2Vec2EOS ONNX inference fallback: {err}"
                )

        return self._fallback_acoustic_eos(pcm_buffer)

    def _fallback_acoustic_eos(self, pcm_buffer: bytes) -> float:
        num_samples = len(pcm_buffer) // 2
        if num_samples < 320:
            return 0.0

        samples = struct.unpack(f"<{num_samples}h", pcm_buffer[: num_samples * 2])
        recent_count = min(3200, num_samples)  # 200ms @ 16kHz
        recent_samples = samples[-recent_count:]
        recent_sum_sq = sum(s * s for s in recent_samples)
        recent_rms = math.sqrt(recent_sum_sq / recent_count)

        prior_count = min(8000, num_samples - recent_count)  # 500ms
        if prior_count > 0:
            prior_samples = samples[-(recent_count + prior_count) : -recent_count]
            prior_sum_sq = sum(s * s for s in prior_samples)
            prior_rms = math.sqrt(prior_sum_sq / prior_count)
            decay_ratio = recent_rms / prior_rms if prior_rms > 0 else 0.0

            if decay_ratio < 0.25:
                return 0.88
            if decay_ratio < 0.45:
                return 0.72

        return 0.85 if recent_rms < 300 else 0.2

    async def close(self) -> None:
        self._session = None
        self._is_loaded = False
