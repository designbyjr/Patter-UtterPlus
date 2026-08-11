import pytest
from getpatter.providers.speech_emotion import SpeechEmotionDetector

@pytest.mark.asyncio
async def test_speech_emotion_detector_heuristic():
    detector = await SpeechEmotionDetector.load()
    silent_pcm = [0.0] * 16000
    res = await detector.predict(silent_pcm)

    assert res.emotion == "neutral"
    assert res.score > 0
    assert res.probabilities["neutral"] > 0.5

@pytest.mark.asyncio
async def test_speech_emotion_detector_high_energy():
    detector = await SpeechEmotionDetector.load()
    loud_pcm = [0.5 * (-1 if i % 2 == 0 else 1) for i in range(16000)]
    res = await detector.predict(loud_pcm)

    assert res.emotion == "angry"
    assert res.score > 0.5
