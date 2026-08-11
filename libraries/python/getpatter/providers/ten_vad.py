"""
TenVAD Provider — High-performance acoustic voice activity detector for telephony pipelines.

Implements VADProvider. Supports auto-loading from default model paths,
in-memory session caching for instant re-instantiation across calls, and ONNX Runtime inference.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
from pathlib import Path
from typing import Any, ClassVar, Literal, Optional, Tuple

import numpy as np

from getpatter.providers.base import VADEvent, VADProvider

logger = logging.getLogger("getpatter.providers.ten_vad")

TENVAD_MODEL_ENV_VAR = "PATTER_TENVAD_MODEL"
_memory_session_cache: dict[str, Any] = {}


def _resolve_default_ten_vad_model_path() -> Optional[str]:
    curr = os.path.dirname(__file__)
    candidates = [
        os.path.join(curr, "..", "resources", "ten_vad.onnx"),
        os.path.join(curr, "..", "resources", "silero_vad.onnx"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return os.path.abspath(c)
    return None


class TenVAD(VADProvider):
    provider: ClassVar[str] = "ONNX"
    model: ClassVar[str] = "ten_vad"

    @classmethod
    def load(
        cls,
        *,
        activation_threshold: float = 0.75,
        deactivation_threshold: float = 0.4,
        min_speech_duration: float = 0.25,
        min_silence_duration: float = 0.4,
        barge_in_threshold_ms: int = 300,
        sample_rate: int = 16000,
        onnx_file_path: Optional[Union[Path, str]] = None,
        force_cpu: bool = True,
    ) -> TenVAD:
        return cls(
            activation_threshold=activation_threshold,
            deactivation_threshold=deactivation_threshold,
            min_speech_duration=min_speech_duration,
            min_silence_duration=min_silence_duration,
            barge_in_threshold_ms=barge_in_threshold_ms,
            sample_rate=sample_rate,
            onnx_file_path=onnx_file_path,
            force_cpu=force_cpu,
        )

    def __init__(
        self,
        activation_threshold: float = 0.75,
        deactivation_threshold: float = 0.4,
        min_speech_duration: float = 0.25,
        min_silence_duration: float = 0.4,
        barge_in_threshold_ms: int = 300,
        sample_rate: int = 16000,
        onnx_file_path: Optional[Union[Path, str]] = None,
        force_cpu: bool = True,
    ) -> None:
        if sample_rate not in (8000, 16000):
            raise ValueError("TenVAD supports 8000 Hz and 16000 Hz sample rates")

        self._sample_rate = sample_rate
        self.activation_threshold = activation_threshold
        self.deactivation_threshold = deactivation_threshold
        self.min_speech_duration = min_speech_duration
        self.min_silence_duration = min_silence_duration
        self.barge_in_threshold_ms = barge_in_threshold_ms

        self._session: Any = None
        self._rnn_state = np.zeros((2, 1, 128), dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)
        self._is_speaking = False
        self._speech_duration_sec = 0.0
        self._silence_duration_sec = 0.0
        self._event_queue: list[VADEvent] = []
        self._closed = False

        raw_path = (
            str(onnx_file_path)
            if onnx_file_path
            else os.environ.get(TENVAD_MODEL_ENV_VAR) or _resolve_default_ten_vad_model_path()
        )
        if raw_path and os.path.exists(raw_path):
            self._init_session(os.path.abspath(raw_path), force_cpu)

    def _init_session(self, model_path: str, force_cpu: bool) -> None:
        if model_path in _memory_session_cache:
            self._session = _memory_session_cache[model_path]
            return

        try:
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            providers = ["CPUExecutionProvider"] if force_cpu else None
            session = ort.InferenceSession(model_path, opts, providers=providers)
            _memory_session_cache[model_path] = session
            self._session = session
            logger.info(f"TenVAD model loaded into memory from: {model_path}")
        except Exception as err:
            logger.warning(f"TenVAD ONNX load failed — falling back to acoustic mode: {err}")

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def num_frames_required(self) -> int:
        return 256 if self.sample_rate == 8000 else 512

    async def process_frame(self, pcm_chunk: bytes, sample_rate: int) -> Optional[VADEvent]:
        if self._closed:
            raise RuntimeError("TenVAD is closed")
        if sample_rate != self._sample_rate:
            raise ValueError(f"Sample rate mismatch: expected {self._sample_rate}, got {sample_rate}")

        if not pcm_chunk:
            return self._event_queue.pop(0) if self._event_queue else None

        samples_i16 = np.frombuffer(pcm_chunk, dtype=np.int16)
        if samples_i16.size == 0:
            return self._event_queue.pop(0) if self._event_queue else None

        samples_f32 = samples_i16.astype(np.float32) / 32768.0
        self._pending = np.concatenate([self._pending, samples_f32])

        window_size = self.num_frames_required()
        frame_duration_sec = window_size / self._sample_rate

        while self._pending.shape[0] >= window_size:
            window = self._pending[:window_size].copy()
            self._pending = self._pending[window_size:]

            if self._session is not None:
                score = self._run_onnx_inference(window)
            else:
                score = self._calculate_speech_probability(window)

            transition = self._advance_state(score, frame_duration_sec)
            if transition is not None:
                self._event_queue.append(transition)

        return self._event_queue.pop(0) if self._event_queue else None

    def _run_onnx_inference(self, window: np.ndarray) -> float:
        if self._session is None:
            return 0.0
        try:
            input_tensor = np.array([window], dtype=np.float32)
            inputs = {
                "input": input_tensor,
                "state": self._rnn_state,
            }
            outputs = self._session.run(None, inputs)
            output_tensor = outputs[0]
            if len(outputs) > 1 and outputs[1] is not None:
                self._rnn_state = outputs[1]
            return float(output_tensor.flat[0])
        except Exception:
            return self._calculate_speech_probability(window)

    def _calculate_speech_probability(self, window: np.ndarray) -> float:
        sum_sq = float(np.sum(window * window))
        rms = math.sqrt(sum_sq / len(window)) if len(window) > 0 else 0.0
        dbfs = 20.0 * math.log10(rms) if rms > 1e-6 else -60.0

        min_dbfs = -45.0
        max_dbfs = -15.0
        if dbfs <= min_dbfs:
            return 0.0
        if dbfs >= max_dbfs:
            return 1.0
        return (dbfs - min_dbfs) / (max_dbfs - min_dbfs)

    def _advance_state(self, score: float, frame_duration_sec: float) -> Optional[VADEvent]:
        is_speech_frame = (
            score >= self.activation_threshold
            or (self._is_speaking and score > self.deactivation_threshold)
        )

        if is_speech_frame:
            self._speech_duration_sec += frame_duration_sec
            self._silence_duration_sec = 0.0

            if not self._is_speaking and self._speech_duration_sec >= self.min_speech_duration:
                self._is_speaking = True
                return VADEvent(
                    type="speech_start",
                    confidence=score,
                    duration_ms=self._speech_duration_sec * 1000.0,
                )
        else:
            self._silence_duration_sec += frame_duration_sec
            self._speech_duration_sec = 0.0

            if self._is_speaking and self._silence_duration_sec >= self.min_silence_duration:
                self._is_speaking = False
                return VADEvent(
                    type="speech_end",
                    confidence=score,
                    duration_ms=self._silence_duration_sec * 1000.0,
                )

        return None

    def reset(self) -> None:
        if self._closed:
            return
        self._pending = np.zeros(0, dtype=np.float32)
        self._is_speaking = False
        self._speech_duration_sec = 0.0
        self._silence_duration_sec = 0.0
        self._event_queue.clear()
        self._rnn_state = np.zeros((2, 1, 128), dtype=np.float32)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._session = None
        self.reset()
