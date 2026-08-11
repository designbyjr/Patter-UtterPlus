"""Unit tests for TenVAD provider in Python SDK."""

import pytest
import struct
from getpatter.providers.ten_vad import TenVAD


@pytest.mark.asyncio
async def test_ten_vad_initialization_and_processing():
    vad = TenVAD(sample_rate=16000, activation_threshold=0.75, min_speech_duration=0.1)
    assert vad.sample_rate == 16000
    assert vad.num_frames_required() == 512

    # Process silence
    silent_pcm = b"\x00" * (512 * 2)
    evt = await vad.process_frame(silent_pcm, 16000)
    assert evt is None

    # Process loud audio (simulated speech frame)
    loud_samples = [15000] * 512
    loud_pcm = struct.pack("<512h", *loud_samples)

    # Process multiple loud frames to cross min_speech_duration threshold
    speech_start_evt = None
    for _ in range(5):
        e = await vad.process_frame(loud_pcm, 16000)
        if e and e.type == "speech_start":
            speech_start_evt = e

    assert speech_start_evt is not None
    assert speech_start_evt.type == "speech_start"

    # Reset
    vad.reset()

    await vad.close()
