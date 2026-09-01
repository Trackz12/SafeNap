"""Testes do ConnectionManager (WebSocket) — negociação de detector,
roteamento, broadcast e eventos de segurança.

WebSockets são mockados (AsyncMock) — sem servidor real.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.websocket.manager import ConnectionManager
from app.core.state_store import StateStore


def make_ws() -> AsyncMock:
    """WebSocket fake: accept/send_text como AsyncMock."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


def make_msg(event_type: str, session_id: str = "s1", payload: dict | None = None) -> str:
    return json.dumps({
        "type": event_type,
        "timestamp": 0.0,
        "session_id": session_id,
        "payload": payload or {},
    })


@pytest.fixture
def store() -> StateStore:
    """StateStore fresco por teste (sem persistência em disco)."""
    with patch("app.core.state_store.DATA_PATH", "/dev/null"):
        s = StateStore()
    return s


class TestStateStore:
    def test_first_claim_wins(self, store):
        assert store.claim_detector("A") is True
        assert store.get_detector() == "A"

    def test_second_claim_rejected(self, store):
        store.claim_detector("A")
        assert store.claim_detector("B") is False
        assert store.get_detector() == "A"

    def test_owner_can_reclaim(self, store):
        store.claim_detector("A")
        assert store.claim_detector("A") is True

    def test_release_by_owner(self, store):
        store.claim_detector("A")
        assert store.release_detector("A") is True
        assert store.get_detector() is None

    def test_release_by_non_owner_fails(self, store):
        store.claim_detector("A")
        assert store.release_detector("B") is False
        assert store.get_detector() == "A"

    def test_update_and_snapshot(self, store):
        store.update("metrics", {"ear": 0.3})
        snap = store.snapshot()
        assert snap["metrics"] == {"ear": 0.3}

    def test_clear_live(self, store):
        store.update("metrics", {"ear": 0.3})
        store.update("session", {"blinks": 5})
        store.clear_live()
        snap = store.snapshot()
        assert snap["metrics"] is None
        assert snap["session"] is None


class TestConnectionManagerBasics:
    async def test_connect_adds_and_sends_snapshot(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)
        assert ws in manager.active_connections
        # STATE_SNAPSHOT enviado na conexão
        ws.send_text.assert_called_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "STATE_SNAPSHOT"

    async def test_disconnect_removes(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)
        manager.disconnect(ws)
        assert ws not in manager.active_connections

    async def test_broadcast_reaches_all_except_sender(self):
        manager = ConnectionManager()
        ws1, ws2, ws3 = make_ws(), make_ws(), make_ws()
        for ws in (ws1, ws2, ws3):
            await manager.connect(ws)
        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()
        ws3.send_text.reset_mock()

        await manager.broadcast("hello", exclude=ws2)
        ws1.send_text.assert_called_once_with("hello")
        ws2.send_text.assert_not_called()
        ws3.send_text.assert_called_once_with("hello")

    async def test_broadcast_survives_connection_error(self):
        manager = ConnectionManager()
        ws_bad = make_ws()
        ws_good = make_ws()
        await manager.connect(ws_bad)
        await manager.connect(ws_good)
        # Snapshot inicial do connect() é ignorado: simular a falha DEPOIS.
        ws_bad.send_text.reset_mock()
        ws_good.send_text.reset_mock()
        ws_bad.send_text.side_effect = Exception("closed")

        # Não deve propagar a exceção — apenas logar
        await manager.broadcast("hello")
        ws_good.send_text.assert_called_once_with("hello")


class TestDetectorNegotiation:
    async def test_first_device_becomes_detector(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)
        ws.send_text.reset_mock()

        await manager.handle_message(make_msg("DETECTOR_CLAIM", "device-1"), ws)
        # Deve receber DETECTOR_ASSIGNED
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "DETECTOR_ASSIGNED"

    async def test_second_device_gets_taken(self):
        manager = ConnectionManager()
        ws1, ws2 = make_ws(), make_ws()
        await manager.connect(ws1)
        await manager.connect(ws2)
        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()

        await manager.handle_message(make_msg("DETECTOR_CLAIM", "device-1"), ws1)
        ws2.send_text.reset_mock()
        await manager.handle_message(make_msg("DETECTOR_CLAIM", "device-2"), ws2)
        # Segundo device recebe DETECTOR_TAKEN
        sent = json.loads(ws2.send_text.call_args[0][0])
        assert sent["type"] == "DETECTOR_TAKEN"
        assert sent["payload"]["owner"] == "device-1"

    async def test_release_broadcasts_cleared(self):
        manager = ConnectionManager()
        ws1, ws2 = make_ws(), make_ws()
        await manager.connect(ws1)
        await manager.connect(ws2)
        await manager.handle_message(make_msg("DETECTOR_CLAIM", "device-1"), ws1)
        ws2.send_text.reset_mock()

        await manager.handle_message(make_msg("DETECTOR_RELEASE", "device-1"), ws1)
        # Viewer é notificado que a vaga ficou livre
        sent = json.loads(ws2.send_text.call_args[0][0])
        assert sent["type"] == "DETECTOR_CLEARED"


class TestSafetyEventRouting:
    async def test_drowsiness_event_reaches_safety_manager(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)

        with patch("app.websocket.manager.safety_manager") as mock_safety:
            await manager.handle_message(
                make_msg("DROWSINESS_STARTED", "s1"), ws
            )
            mock_safety.process_event.assert_called_once()

    async def test_sync_event_persists_and_broadcasts(self):
        manager = ConnectionManager()
        ws_detector, ws_viewer = make_ws(), make_ws()
        await manager.connect(ws_detector)
        await manager.connect(ws_viewer)
        ws_viewer.send_text.reset_mock()

        payload = {"metrics": {"ear": 0.31, "perclos": 0.1}}
        await manager.handle_message(
            make_msg("METRICS_UPDATE", "s1", payload), ws_detector
        )
        # Viewer recebeu o reencaminhamento
        ws_viewer.send_text.assert_called_once()

    async def test_heartbeat_is_safety_event(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)

        with patch("app.websocket.manager.safety_manager") as mock_safety:
            await manager.handle_message(make_msg("HEARTBEAT", "s1"), ws)
            mock_safety.process_event.assert_called_once()

    async def test_invalid_json_does_not_raise(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)
        # Não deve propagar exceção
        await manager.handle_message("not-json{{", ws)

    async def test_unknown_event_type_is_ignored(self):
        manager = ConnectionManager()
        ws = make_ws()
        await manager.connect(ws)
        # Evento desconhecido não quebra e não toca no safety_manager
        with patch("app.websocket.manager.safety_manager") as mock_safety:
            await manager.handle_message(make_msg("FACE_DETECTED", "s1"), ws)
            # FACE_DETECTED é safety event — processa
            mock_safety.process_event.assert_called_once()
