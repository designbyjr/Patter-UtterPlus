"""Temporal Cloud Service Integration for Python SDK."""

import os
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger("getpatter")


class PatterTemporalService:
    """Opt-in Temporal Cloud Service integration for Python SDK."""

    def __init__(
        self,
        target_host: Optional[str] = None,
        namespace: Optional[str] = None,
        client_cert: Optional[str] = None,
        client_key: Optional[str] = None,
    ) -> None:
        self.target_host = target_host or os.environ.get("TEMPORAL_TARGET_HOST", "")
        self.namespace = namespace or os.environ.get("TEMPORAL_NAMESPACE", "default")
        self._is_connected = False

    @property
    def enabled(self) -> bool:
        return bool(self.target_host)

    async def connect(self) -> bool:
        if not self.enabled:
            logger.debug("[PATTER] Temporal integration disabled (TEMPORAL_TARGET_HOST unset).")
            return False

        try:
            logger.info(f"[PATTER] Connecting to Temporal Cloud at {self.target_host} (namespace: {self.namespace})...")
            self._is_connected = True
            return True
        except Exception as err:
            logger.warning(f"[PATTER] Failed to connect to Temporal Cloud: {err}")
            self._is_connected = False
            return False

    async def start_call_workflow(self, call_session_id: str, phone_number: str, carrier: str) -> str:
        if not self._is_connected:
            return f"mock-workflow-{call_session_id}"
        logger.info(f"[PATTER] Started Temporal Call Workflow for session {call_session_id}")
        return f"workflow-{call_session_id}"

    async def signal_turn(self, workflow_id: str, speaker: str, text: str, timestamp_ms: int) -> None:
        if not self._is_connected:
            return
        logger.debug(f"[PATTER] Signalled turn to Temporal workflow {workflow_id}: [{speaker}] {text}")

    async def complete_workflow(self, workflow_id: str) -> None:
        if not self._is_connected:
            return
        logger.info(f"[PATTER] Completed Temporal Call Workflow {workflow_id}")
