"""
Deepgram Flux Streaming STT Adapter for Cloudflare Workers AI & Deepgram Flux WebSocket endpoint.

Connects via WebSocket to streaming `@cf/deepgram/flux` or custom Cloudflare proxy endpoints,
parsing `TurnInfo` messages and mapping `StartOfTurn`, `Update`, `EagerEndOfTurn`,
`TurnResumed`, and `EndOfTurn` events into Patter-normalized Transcript objects.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, ClassVar, Optional, Union
from urllib.parse import urlencode

import websockets
from websockets.exceptions import InvalidStatus

from getpatter.exceptions import (
    AuthenticationError,
    PatterConnectionError,
    RateLimitError,
)
from getpatter.providers.base import STTProvider, Transcript

logger = logging.getLogger("getpatter.providers.deepgram_flux_stt")

DEFAULT_FLUX_WS_URL = "wss://api.deepgram.com/v1/listen?model=flux-general-en&encoding=linear16&sample_rate=16000"


class DeepgramFluxSTT(STTProvider):
    provider_key: ClassVar[str] = "deepgram_flux"

    def __init__(
        self,
        api_key: str = "",
        url: str = "",
        model: str = "@cf/deepgram/flux",
        language: str = "en",
        sample_rate: int = 16000,
        encoding: str = "linear16",
    ) -> None:
        self.api_key = api_key
        self.url = url
        self.model = model
        self.language = language
        self.sample_rate = sample_rate
        self.encoding = encoding
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self.request_id: Optional[str] = None
        self._audio_bytes_sent = 0

    async def connect(self) -> None:
        ws_url = self.url or DEFAULT_FLUX_WS_URL
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Token {self.api_key}"

        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(ws_url, additional_headers=headers),
                timeout=10.0,
            )
        except InvalidStatus as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code in (401, 403):
                raise AuthenticationError(
                    f"Deepgram Flux rejected API key (HTTP {status_code})."
                ) from exc
            if status_code == 429:
                raise RateLimitError("Deepgram Flux rate limit exceeded (HTTP 429).") from exc
            raise PatterConnectionError(
                f"Deepgram Flux WebSocket upgrade failed (HTTP {status_code})."
            ) from exc
        except (OSError, asyncio.TimeoutError) as exc:
            raise PatterConnectionError(
                f"Failed to connect to Deepgram Flux: {exc}"
            ) from exc

    async def send_audio(self, audio_chunk: bytes) -> None:
        if self._ws is None:
            raise RuntimeError("Not connected. Call connect() first.")
        if not audio_chunk:
            return
        self._audio_bytes_sent += len(audio_chunk)
        await self._ws.send(audio_chunk)

    async def finalize(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "Finalize"}))
            except Exception:
                pass

    def _parse_message(self, raw_message: str) -> Optional[Transcript]:
        try:
            data = json.loads(raw_message)
        except Exception:
            return None

        msg_type = data.get("type", "")
        if msg_type == "Metadata":
            self.request_id = data.get("request_id")
            return None

        if msg_type != "TurnInfo" and "event" not in data:
            return None

        event = data.get("event")
        text = (data.get("transcript") or "").strip()
        request_id = data.get("request_id") or self.request_id
        end_of_turn_confidence = float(data.get("end_of_turn_confidence", 0.0))
        words = data.get("words", []) or []

        if event == "StartOfTurn":
            return Transcript(
                text="",
                is_final=False,
                confidence=0.0,
                event_type="SpeechStarted",
                request_id=request_id,
            )

        if event == "Update":
            return Transcript(
                text=text,
                is_final=False,
                confidence=0.8,
                event_type="Results",
                words=tuple(words),
                request_id=request_id,
            )

        if event == "EagerEndOfTurn":
            return Transcript(
                text=text,
                is_final=True,
                speech_final=True,
                confidence=end_of_turn_confidence or 0.75,
                event_type="Results",
                words=tuple(words),
                request_id=request_id,
            )

        if event == "TurnResumed":
            return Transcript(
                text=text,
                is_final=False,
                confidence=0.5,
                event_type="SpeechStarted",
                request_id=request_id,
            )

        if event == "EndOfTurn":
            return Transcript(
                text=text,
                is_final=True,
                speech_final=True,
                confidence=end_of_turn_confidence or 0.95,
                event_type="UtteranceEnd",
                words=tuple(words),
                request_id=request_id,
            )

        return None

    async def receive_transcripts(self) -> AsyncIterator[Transcript]:
        if self._ws is None:
            raise RuntimeError("Not connected. Call connect() first.")

        async for raw_message in self._ws:
            if isinstance(raw_message, bytes):
                continue
            transcript = self._parse_message(raw_message)
            if transcript is not None:
                yield transcript

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
