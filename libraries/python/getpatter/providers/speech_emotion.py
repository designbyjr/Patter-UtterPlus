"""
Speech Emotion Recognition Provider (Wav2Vec2 ONNX).

Model: onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX
Analyzes audio PCM streams to predict real-time speaker emotions
(happy, sad, angry, neutral, fear, disgust, surprise).
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass
from typing import Dict, List, Optional

logger = logging.getLogger("getpatter")

EMOTION_LABELS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"]


@dataclass(frozen=True)
class EmotionPrediction:
    emotion: str
    score: float
    probabilities: Dict[str, float]


class SpeechEmotionDetector:
    """Predicts speaker emotion probabilities from PCM float32 audio using Wav2Vec2 ONNX."""

    def __init__(self, model_path: Optional[str] = None, threshold: float = 0.4):
        self.model_path = model_path or os.environ.get("PATTER_EMOTION_MODEL")
        self.threshold = threshold
        self.session = None
        self._closed = False

        if self.model_path and os.path.exists(self.model_path):
            try:
                import onnxruntime as ort

                self.session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
                logger.info(f"[PATTER] SpeechEmotionDetector: loaded model from {self.model_path}")
            except Exception as exc:
                logger.warning(f"[PATTER] SpeechEmotionDetector init error: {exc}")

    @classmethod
    async def load(cls, model_path: Optional[str] = None, threshold: float = 0.4) -> "SpeechEmotionDetector":
        return cls(model_path=model_path, threshold=threshold)

    async def predict(self, pcm_float32: List[float]) -> EmotionPrediction:
        if self._closed:
            raise RuntimeError("SpeechEmotionDetector is closed")

        if not self.session:
            return self._heuristic_fallback(pcm_float32)

        try:
            import numpy as np

            arr = np.array(pcm_float32, dtype=np.float32)[np.newaxis, :]
            input_name = self.session.get_inputs()[0].name
            results = self.session.run(None, {input_name: arr})
            logits = results[0][0]

            probs = self._softmax(logits.tolist())
            max_idx = int(np.argmax(probs))
            max_prob = float(probs[max_idx])

            prob_map = {label: round(float(probs[i]), 3) for i, label in enumerate(EMOTION_LABELS)}
            return EmotionPrediction(
                emotion=EMOTION_LABELS[max_idx],
                score=round(max_prob, 3),
                probabilities=prob_map,
            )
        except Exception as exc:
            logger.warning(f"[PATTER] SpeechEmotionDetector prediction error: {exc}")
            return self._heuristic_fallback(pcm_float32)

    def _softmax(self, logits: List[float]) -> List[float]:
        max_l = max(logits)
        exps = [math.exp(l - max_l) for l in logits]
        sum_e = sum(exps)
        return [e / sum_e for e in exps]

    def _heuristic_fallback(self, pcm: List[float]) -> EmotionPrediction:
        sum_sq = sum(x * x for x in pcm)
        rms = math.sqrt(sum_sq / max(1, len(pcm)))

        is_high = rms > 0.15
        emotion = "angry" if is_high else "neutral"
        score = 0.65 if is_high else 0.85

        return EmotionPrediction(
            emotion=emotion,
            score=score,
            probabilities={
                "angry": 0.65 if is_high else 0.05,
                "neutral": 0.15 if is_high else 0.85,
                "happy": 0.10,
                "sad": 0.05,
                "fear": 0.02,
                "disgust": 0.02,
                "surprise": 0.01,
            },
        )

    async def close(self) -> None:
        self._closed = True
        self.session = None
