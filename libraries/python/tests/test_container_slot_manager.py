"""Unit tests for ContainerSlotManager in Python SDK."""

import asyncio
import os
import pytest
import urllib.request
import json
from getpatter.utils.container_slot_manager import ContainerSlotManager, container_slot_manager


@pytest.mark.asyncio
async def test_container_slot_manager_acquire_and_release():
    mgr = ContainerSlotManager(max_slots=3, http_port=0, container_id="test-cont")
    assert mgr.max_slots == 3
    assert mgr.available_slots == 3
    assert not mgr.is_at_capacity

    # Acquire 3 slots
    assert mgr.acquire("call_1") is True
    assert mgr.acquire("call_2") is True
    assert mgr.acquire("call_3") is True

    # Re-acquiring active id is idempotent
    assert mgr.acquire("call_1") is True
    assert mgr.active_count == 3
    assert mgr.is_at_capacity

    # 4th slot rejected
    assert mgr.acquire("call_4") is False

    # Release 1 slot
    mgr.release("call_2")
    assert mgr.active_count == 2
    assert mgr.available_slots == 1
    assert not mgr.is_at_capacity

    # Release unacquired slot is safe
    mgr.release("nonexistent")
    assert mgr.active_count == 2

    stats = mgr.get_capacity_stats()
    assert stats.container_id == "test-cont"
    assert stats.status == "HEALTHY"
    assert stats.active_calls == 2
    assert stats.max_slots == 3
    assert stats.available_slots == 1

    await mgr.close()


@pytest.mark.asyncio
async def test_container_slot_manager_high_watermark():
    fired = []

    def on_hw(active, max_s):
        fired.append((active, max_s))

    mgr = ContainerSlotManager(max_slots=10, high_watermark_ratio=0.80, http_port=0, on_high_watermark=on_hw)

    for i in range(7):
        mgr.acquire(f"call_{i}")

    assert len(fired) == 0

    # 8th call triggers 80% watermark
    mgr.acquire("call_7")
    assert len(fired) == 1
    assert fired[0] == (8, 10)

    # 9th call does not re-fire (latched)
    mgr.acquire("call_8")
    assert len(fired) == 1

    # Release back below 80% resets latch
    mgr.release("call_8")
    mgr.release("call_7")
    mgr.release("call_6")

    # Crossing threshold again re-fires
    for i in range(6, 9):
        mgr.acquire(f"call_{i}")
    assert len(fired) == 2

    await mgr.close()


@pytest.mark.asyncio
async def test_container_slot_manager_http_server():
    # Pick a random free port for testing
    mgr = ContainerSlotManager(max_slots=5, http_port=18080, container_id="http-cont")
    await mgr.start_server()

    try:
        mgr.acquire("http_call_1")

        req = await asyncio.to_thread(urllib.request.urlopen, "http://127.0.0.1:18080/capacity", timeout=2)
        assert req.status == 200
        data = json.loads(req.read().decode("utf-8"))
        assert data["container_id"] == "http-cont"
        assert data["active_calls"] == 1
        assert data["max_slots"] == 5

        req_health = await asyncio.to_thread(urllib.request.urlopen, "http://127.0.0.1:18080/health", timeout=2)
        assert req_health.status == 200

    finally:
        await mgr.close()


def test_singleton_export():
    assert container_slot_manager is not None
    assert isinstance(container_slot_manager, ContainerSlotManager)
