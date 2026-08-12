"""Unit tests for PatterTemporalService in Python SDK."""

import os
import pytest
from getpatter.services.temporal import PatterTemporalService


@pytest.mark.asyncio
async def test_python_temporal_service_defaults():
    if "TEMPORAL_TARGET_HOST" in os.environ:
        del os.environ["TEMPORAL_TARGET_HOST"]
    service = PatterTemporalService()
    assert service.enabled is False


@pytest.mark.asyncio
async def test_python_temporal_service_connect():
    service = PatterTemporalService(
        target_host="patter-prod.a1b2c.tmprl.cloud:7233",
        namespace="patter-prod",
    )
    assert service.enabled is True

    ok = await service.connect()
    assert ok is True

    workflow_id = await service.start_call_workflow("session-py-123", "+15551234567", "telnyx")
    assert workflow_id == "workflow-session-py-123"

    await service.signal_turn(workflow_id, "user", "Hello Python agent", 1700000000000)
    await service.complete_workflow(workflow_id)
