"""
ContainerSlotManager — in-process call slot gatekeeper for Cloudflare Container deployments.

Tracks active Telnyx WebSocket sessions by call_session_id, enforces MAX_CONTAINER_CALL_SLOTS,
and exposes a /capacity + /health HTTP endpoint polled by the Cloudflare Durable Object
edge router for routing decisions.
"""

from __future__ import annotations

import asyncio
import logging
import os
import resource
import socket
import sys
import time

from dataclasses import dataclass, asdict
from typing import Callable, Optional, Set

logger = logging.getLogger("getpatter")


@dataclass(frozen=True)
class CapacityStats:
    container_id: str
    status: str  # "HEALTHY" | "AT_CAPACITY"
    active_calls: int
    max_slots: int
    available_slots: int
    memory_rss_mb: int
    cpu_utilization_pct: float
    uptime_seconds: int


class ContainerSlotManager:
    def __init__(
        self,
        max_slots: Optional[int] = None,
        high_watermark_ratio: float = 0.80,
        http_port: Optional[int] = None,
        on_high_watermark: Optional[Callable[[int, int], None]] = None,
        cooldown_seconds: float = 120.0,
        on_cooldown_complete: Optional[Callable[[], None]] = None,
        container_id: Optional[str] = None,
    ) -> None:
        if max_slots is None:
            max_slots = int(os.environ.get("MAX_CONTAINER_CALL_SLOTS", "15"))
        self.max_slots = max_slots
        self.high_watermark_ratio = high_watermark_ratio
        self.cooldown_seconds = float(os.environ.get("CONTAINER_COOLDOWN_SECONDS", str(cooldown_seconds)))
        self.on_cooldown_complete = on_cooldown_complete
        self.container_id = container_id or os.environ.get("CONTAINER_ID") or socket.gethostname()
        self.on_high_watermark = on_high_watermark

        self._active_sessions: Set[str] = set()
        self._high_watermark_fired = False
        self._is_cooling_down = False
        self._cooldown_task: Optional[asyncio.TimerHandle] = None
        self._start_time = time.time()
        self._server: Optional[asyncio.AbstractServer] = None
        self._last_process_cpu = time.process_time()
        self._last_wall_cpu = time.time()
        self._cpu_percent = 0.0

        if http_port is None:
            port_env = os.environ.get("CAPACITY_HTTP_PORT", "8080")
            http_port = int(port_env) if port_env.isdigit() else 8080

        self._http_port = http_port

    async def start_server(self) -> None:
        if self._http_port > 0 and self._server is None:
            await self._start_http_server(self._http_port)

    def acquire(self, call_session_id: str) -> bool:
        """
        Attempt to acquire a call slot for the given call_session_id.
        Returns True if acquired (or re-acquired), False if container at capacity.
        """
        if call_session_id in self._active_sessions:
            return True
        if len(self._active_sessions) >= self.max_slots:
            logger.warning(
                f"[PATTER] ContainerSlotManager: at capacity ({len(self._active_sessions)}/{self.max_slots}), "
                f"rejecting {call_session_id}"
            )
            return False

        self._cancel_cooldown()
        self._active_sessions.add(call_session_id)
        self._maybe_fire_high_watermark()
        logger.debug(
            f"[PATTER] ContainerSlotManager: +slot {call_session_id} "
            f"({len(self._active_sessions)}/{self.max_slots})"
        )
        return True

    def release(self, call_session_id: str) -> None:
        """
        Release the slot held by call_session_id. Safe to call if id was never acquired.
        """
        if call_session_id not in self._active_sessions:
            return
        self._active_sessions.remove(call_session_id)
        if len(self._active_sessions) / self.max_slots < self.high_watermark_ratio:
            self._high_watermark_fired = False

        logger.debug(
            f"[PATTER] ContainerSlotManager: -slot {call_session_id} "
            f"({len(self._active_sessions)}/{self.max_slots})"
        )

        if len(self._active_sessions) == 0 and self.cooldown_seconds > 0:
            self._start_cooldown()

    @property
    def active_count(self) -> int:
        return len(self._active_sessions)

    @property
    def available_slots(self) -> int:
        return max(0, self.max_slots - len(self._active_sessions))

    @property
    def is_at_capacity(self) -> bool:
        return len(self._active_sessions) >= self.max_slots

    @property
    def is_cooling_down(self) -> bool:
        return self._is_cooling_down

    def _sample_cpu(self) -> float:
        now_wall = time.time()
        now_proc = time.process_time()
        wall_diff = now_wall - self._last_wall_cpu
        if wall_diff > 0:
            self._cpu_percent = ((now_proc - self._last_process_cpu) / wall_diff) * 100
        self._last_wall_cpu = now_wall
        self._last_process_cpu = now_proc
        return self._cpu_percent

    def get_capacity_stats(self) -> CapacityStats:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # rss in maxrss is kilobytes on Linux / bytes on macOS.
        if sys.platform == "darwin":
            rss_mb = int(usage.ru_maxrss / (1024 * 1024))
        else:
            rss_mb = int(usage.ru_maxrss / 1024)

        status = "HEALTHY"
        if self.is_at_capacity:
            status = "AT_CAPACITY"
        elif self._is_cooling_down:
            status = "DRAINING_COOLDOWN"

        return CapacityStats(
            container_id=self.container_id,
            status=status,
            active_calls=len(self._active_sessions),
            max_slots=self.max_slots,
            available_slots=self.available_slots,
            memory_rss_mb=rss_mb,
            cpu_utilization_pct=round(self._sample_cpu(), 1),
            uptime_seconds=int(time.time() - self._start_time),
        )

    def _start_cooldown(self) -> None:
        self._cancel_cooldown()
        self._is_cooling_down = True
        logger.info(
            f"[PATTER] ContainerSlotManager: 0 active calls — entering {self.cooldown_seconds}s cooldown "
            f"for background task/API polling completion"
        )
        try:
            loop = asyncio.get_running_loop()
            self._cooldown_task = loop.call_later(self.cooldown_seconds, self._on_cooldown_timer_expired)
        except RuntimeError:
            pass

    def _on_cooldown_timer_expired(self) -> None:
        self._is_cooling_down = False
        self._cooldown_task = None
        logger.info("[PATTER] ContainerSlotManager: cooldown period completed")
        if self.on_cooldown_complete:
            self.on_cooldown_complete()

    def _cancel_cooldown(self) -> None:
        if self._cooldown_task:
            self._cooldown_task.cancel()
            self._cooldown_task = None
        if self._is_cooling_down:
            self._is_cooling_down = False
            logger.info("[PATTER] ContainerSlotManager: cooldown interrupted by new incoming call")

    async def close(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    def _maybe_fire_high_watermark(self) -> None:
        if self._high_watermark_fired:
            return
        ratio = len(self._active_sessions) / self.max_slots
        if ratio >= self.high_watermark_ratio:
            self._high_watermark_fired = True
            logger.info(
                f"[PATTER] ContainerSlotManager: high-watermark reached "
                f"({len(self._active_sessions)}/{self.max_slots}, {round(ratio * 100)}%) — signalling pre-warm"
            )
            if self.on_high_watermark:
                self.on_high_watermark(len(self._active_sessions), self.max_slots)

    async def _start_http_server(self, port: int) -> None:
        async def handle_request(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                data = await reader.read(2048)
                request_line = data.decode("utf-8", errors="ignore").split("\r\n")[0]
                parts = request_line.split(" ")
                method = parts[0] if len(parts) > 0 else ""
                path = parts[1].split("?")[0] if len(parts) > 1 else ""

                if method != "GET":
                    response = b"HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\n\r\n"
                elif path in ("/capacity", "/health"):
                    import json

                    stats = asdict(self.get_capacity_stats())
                    body = json.dumps(stats).encode("utf-8")
                    headers = (
                        f"HTTP/1.1 200 OK\r\n"
                        f"Content-Type: application/json\r\n"
                        f"Content-Length: {len(body)}\r\n\r\n"
                    ).encode("utf-8")
                    response = headers + body
                else:
                    response = b"HTTP/1.1 404 Not Found\r\n\r\n"

                writer.write(response)
                await writer.drain()
            except Exception as err:
                logger.warning(f"[PATTER] ContainerSlotManager: HTTP handle error: {err}")
            finally:
                writer.close()
                await writer.wait_closed()

        try:
            self._server = await asyncio.start_server(handle_request, "0.0.0.0", port)
            logger.info(f"[PATTER] ContainerSlotManager: capacity endpoint listening on :{port}")
        except Exception as err:
            logger.warning(f"[PATTER] ContainerSlotManager: HTTP server error: {err}")


container_slot_manager = ContainerSlotManager()
