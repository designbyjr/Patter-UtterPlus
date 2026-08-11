"""Unit tests for TelnyxWav2Vec2EOS provider in Python SDK."""

import pytest
import struct
from getpatter.providers.telnyx_wav2vec2 import TelnyxWav2Vec2EOS


@pytest.mark.asyncio
async def test_telnyx_wav2vec2_empty_buffer():
    model = TelnyxWav2Vec2EOS()
    score = await model.predict_eos(b"")
    assert score == 0.0
    await model.close()


@pytest.mark.asyncio
async def test_telnyx_wav2vec2_fallback_acoustic_scores():
    model = TelnyxWav2Vec2EOS()
    # 700ms @ 16kHz = 11,200 samples = 22,400 bytes
    # Create silent trailing buffer
    samples = [1000] * 8000 + [10] * 3200
    pcm = struct.pack(f"<{len(samples)}h", *samples)

    score = await model.predict_eos(pcm)
    assert 0.0 <= score <= 1.0
    # Decay ratio of 10 vs 1000 is < 0.25, so should return high EOS score
    assert score >= 0.70

    await model.close()


@pytest.mark.asyncio
async def test_telnyx_wav2vec2_explicit_load():
    model = await TelnyxWav2Vec2EOS.load(threshold=0.85)
    assert model.threshold == 0.85
    score = await model.predict_eos(b"\x00" * 3200)
    assert 0.0 <= score <= 1.0
    await model.close()
