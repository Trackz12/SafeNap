"""Autenticacao por token compartilhado do SafeNap.

O backend roda em rede local (LAN/Tailscale) com hardware de seguranca
(buzzer/vibracao) no outro extremo. Sem autenticacao, QUALQUER device na
rede poderia disparar o buzzer ou conectar/roubar o papel de detector.

Modelo escolhido (simples e adequado ao contexto):
- Um token compartilhado definido na env var SAFENAP_AUTH_TOKEN.
- REST: header `Authorization: Bearer <token>` (ou query `?token=`).
- WebSocket: query param `?token=` (headers em WS sao menos portateis).
- Se SAFENAP_AUTH_TOKEN nao estiver definida, a autenticacao fica
  DESLIGADA (modo desenvolvimento local) e um aviso e logado.

Uso: gere um token forte, ex `python -c "import secrets; print(secrets.token_urlsafe(32))"`,
exporte no ambiente do backend e no frontend (VITE_SAFENAP_TOKEN ou
usando o mesmo .env do frontend).
"""

import logging
import os
import secrets

from fastapi import HTTPException, Request, WebSocket

logger = logging.getLogger(__name__)


def _env_token() -> str | None:
    """Token configurado ou None (auth desativada)."""
    token = os.environ.get("SAFENAP_AUTH_TOKEN", "").strip()
    return token or None


def auth_enabled() -> bool:
    """True quando um token esta configurado no ambiente."""
    return _env_token() is not None


def _check(token_candidate: str | None) -> bool:
    """Comparacao em tempo constante (resistente a timing attack)."""
    expected = _env_token()
    if expected is None:
        return True  # auth desativada
    if not token_candidate:
        return False
    return secrets.compare_digest(token_candidate, expected)


def extract_bearer_token(request: Request) -> str | None:
    """Extrai o token de Authorization: Bearer ou query string (?token=)."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    # Fallback: query param (conveniencia para links de teste rapido)
    return request.query_params.get("token")


def require_rest_auth(request: Request) -> None:
    """Dependencia FastAPI: valida o token em rotas REST.

    Levanta 401 quando o token nao bate. Um 429 simples por IP seria um
    proximo passo; aqui mantemos a validacao O(1) por requisicao.
    """
    if not auth_enabled():
        return
    if not _check(extract_bearer_token(request)):
        logger.warning(
            "Token invalido/ausente em %s %s",
            request.method,
            request.url.path,
        )
        raise HTTPException(status_code=401, detail="Token de autenticacao invalido")


def check_ws_auth(websocket: WebSocket) -> bool:
    """Valida o token de um WebSocket (via ?token= na URL de conexao).

    Retorna True quando autorizado (ou auth desativada). Nao levanta:
    o chamador decide como fechar a conexao (code 1008 policy violation).
    """
    if not auth_enabled():
        return True
    token = websocket.query_params.get("token")
    return _check(token)


if auth_enabled():
    logger.info("Autenticacao por token ATIVADA.")
else:
    logger.warning(
        "SAFENAP_AUTH_TOKEN nao configurada: autenticacao DESATIVADA. "
        "Qualquer device na rede pode controlar o hardware. Configure-a em producao."
    )
