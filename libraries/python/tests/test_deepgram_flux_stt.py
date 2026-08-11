"""Unit tests for DeepgramFluxSTT provider in Python SDK."""

import pytest
from getpatter.providers.deepgram_flux_stt import DeepgramFluxSTT


def test_deepgram_flux_parse_messages():
    stt = DeepgramFluxSTT(api_key="test-key")

    # StartOfTurn event
    t1 = stt._parse_message('{"type": "TurnInfo", "event": "StartOfTurn", "request_id": "req-1"}')
    assert t1 is not None
    assert t1.event_type == "SpeechStarted"
    assert t1.is_final is False

    # Update event
    t2 = stt._parse_message('{"type": "TurnInfo", "event": "Update", "transcript": "hello world"}')
    assert t2 is not None
    assert t2.text == "hello world"
    assert t2.is_final is False

    # EagerEndOfTurn event
    t3 = stt._parse_message('{"type": "TurnInfo", "event": "EagerEndOfTurn", "transcript": "hello world", "end_of_turn_confidence": 0.88}')
    assert t3 is not None
    assert t3.text == "hello world"
    assert t3.is_final is True
    assert t3.speech_final is True
    assert t3.confidence == 0.88

    # EndOfTurn event
    t4 = stt._parse_message('{"type": "TurnInfo", "event": "EndOfTurn", "transcript": "hello world final", "end_of_turn_confidence": 0.96}')
    assert t4 is not None
    assert t4.text == "hello world final"
    assert t4.is_final is True
    assert t4.event_type == "UtteranceEnd"
