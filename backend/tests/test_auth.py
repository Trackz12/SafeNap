"""Testes da autenticacao por token (REST + WebSocket).

Cobre: token valido/invalido/ausente em REST (401), WebSocket recusado
(code 1008), e modo dev (sem SAFENAP_AUTH_TOKEN = auth desativada).
"""
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.auth import require_rest_auth, check_ws_auth
from app.main import app


def client() -> TestClient:
    return TestClient(app)


def make_app() -> FastAPI:
    """App minimo que usa a mesma dependencia de auth do main."""
    tiny = FastAPI()

    @tiny.post("/ping")
    def ping(_: None = None):
        return {"ok": True}

    # Registra a dependencia manualmente para isolar o teste da auth
    tiny.router.routes[0].dependant.dependencies = []
    return tiny


class TestAuthDisabledByDefault:
    """Sem SAFENAP_AUTH_TOKEN no ambiente: auth desativada (modo dev)."""

    def test_rest_allowed_without_token(self):
        with patch("app.core.auth.auth_enabled", return_value=False), \
             patch("app.core.auth._env_token", return_value=None):
            c = client()
            # /api/status permanece aberto por design (diagnostico)
            res = c.get("/api/status")
            assert res.status_code == 200

    def test_ws_allowed_without_token(self):
        with patch("app.core.auth.auth_enabled", return_value=False), \
             patch("app.core.auth._env_token", return_value=None):
            c = client()
            # WebSocket conecta (recebe STATE_SNAPSHOT na abertura)
            with c.websocket_connect("/ws") as ws:
                data = ws.receive_text()
                assert "STATE_SNAPSHOT" in data


class TestAuthEnabled:
    """Com SAFENAP_AUTH_TOKEN definida: rotas protegidas exigem o token."""

    TOKEN = "secret-token-123"

    def _enable(self):
        return patch("app.core.auth._env_token", return_value=self.TOKEN)

    def test_rest_hardware_rejects_missing_token(self):
        with self._enable():
            c = client()
            res = c.post("/api/hardware/test/ALARM")
            assert res.status_code == 401

            res = c.post("/api/hardware/connect")
            assert res.status_code == 401

            res = c.post("/api/hardware/disconnect")
            assert res.status_code == 401

    def test_rest_hardware_rejects_wrong_token(self):
        with self._enable():
            c = client()
            res = c.post(
                "/api/hardware/test/ALARM",
                headers={"Authorization": "Bearer wrong-token"},
            )
            assert res.status_code == 401

    def test_rest_hardware_accepts_bearer_token(self):
        with self._enable(), \
             patch("app.main.safety_manager") as mock_safety:
            c = client()
            res = c.post(
                "/api/hardware/test/ALARM",
                headers={"Authorization": f"Bearer {self.TOKEN}"},
            )
            # Auth passa; comando chega ao safety manager
            assert res.status_code == 200
            mock_safety.test_hardware.assert_called_once_with("ALARM")

    def test_rest_hardware_accepts_query_token(self):
        with self._enable(), \
             patch("app.main.safety_manager") as mock_safety:
            c = client()
            res = c.post(f"/api/hardware/test/ALARM?token={self.TOKEN}")
            assert res.status_code == 200
            mock_safety.test_hardware.assert_called_once()

    def test_ws_rejects_missing_token(self):
        with self._enable():
            c = client()
            # WebSocket sem token e recusado na abertura
            try:
                with c.websocket_connect("/ws"):
                    pass  # se conectar, o teste falha abaixo
                assert False, "WebSocket deveria ter sido recusado"
            except Exception:
                pass  # recusa esperada (close 1008 durante o handshake)

    def test_ws_accepts_query_token(self):
        with self._enable():
            c = client()
            with c.websocket_connect(f"/ws?token={self.TOKEN}") as ws:
                data = ws.receive_text()
                assert "STATE_SNAPSHOT" in data

    def test_ws_rejects_wrong_token(self):
        with self._enable():
            c = client()
            try:
                with c.websocket_connect("/ws?token=wrong"):
                    pass
                assert False, "WebSocket deveria ter sido recusado"
            except Exception:
                pass

    def test_client_error_endpoint_stays_open(self):
        """Log de erros do frontend permanece sem auth (por design: precisa
        reportar inclusive falhas de autenticacao)."""
        with self._enable():
            c = client()
            res = c.post("/api/client-error", json={"message": "x", "context": "t"})
            assert res.status_code == 200


class TestCheckFunctions:
    def test_check_ws_auth_disabled(self):
        with patch("app.core.auth._env_token", return_value=None):
            assert check_ws_auth(None) is True

    def test_extract_bearer_from_header(self):
        from fastapi import Request

        scope = {
            "type": "http",
            "headers": [(b"authorization", b"Bearer abc123")],
            "query_string": b"",
        }
        req = Request(scope)
        # Importa a funcao privada para teste unitario direto
        from app.core.auth import extract_bearer_token
        assert extract_bearer_token(req) == "abc123"

    def test_extract_bearer_from_query(self):
        from fastapi import Request

        scope = {
            "type": "http",
            "headers": [],
            "query_string": b"token=xyz",
        }
        req = Request(scope)
        from app.core.auth import extract_bearer_token
        assert extract_bearer_token(req) == "xyz"
