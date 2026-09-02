import asyncio
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os
import time

from app.websocket.manager import ws_manager
from app.serial.manager import serial_manager
from app.safety.manager import safety_manager
from app.core.state_store import state_store
from app.core.auth import require_rest_auth, check_ws_auth
import json

# Configura log
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()

    # Callback executado em thread de background: precisa de call agendado
    # no event loop do asyncio para emitir o broadcast com seguranca.
    def on_serial_status_change(connected: bool):
        msg = {
            "type": "HARDWARE_STATUS",
            "payload": {
                "connected": connected,
                "responsive": serial_manager.is_responsive(),
            },
        }
        try:
            asyncio.run_coroutine_threadsafe(
                ws_manager.broadcast(json.dumps(msg)), loop
            )
        except Exception as e:
            logger.error(f"Erro ao emitir HARDWARE_STATUS: {e}")

    serial_manager.on_status_change_callback = on_serial_status_change

    # Startup: ativa a sondagem automatica. Se o Arduino ja estiver plugado,
    # conecta na hora; caso contrario, tenta a cada 5s ate ser encontrado.
    serial_manager.start_auto_connect()
    yield
    # Shutdown
    serial_manager.stop_auto_connect()
    serial_manager.disconnect()

app = FastAPI(title="SAFENAP Web API", lifespan=lifespan)

# CORS: permite frontend local (dev) e Vercel (produção)
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://localhost:5173",
]
# Adiciona origem do Vercel se configurada
vercel_origin = os.environ.get("VERCEL_URL")
if vercel_origin:
    CORS_ORIGINS.append(f"https://{vercel_origin}")
# Permite Tailscale via env var (nao hardcode)
CORS_EXTRA = os.environ.get("CORS_EXTRA_ORIGINS", "")
for origin in CORS_EXTRA.split(","):
    origin = origin.strip()
    if origin:
        CORS_ORIGINS.append(origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Autenticacao por token (?token=...): recusa com 1008 se invalido.
    if not check_ws_auth(websocket):
        logger.warning("WebSocket recusado: token invalido/ausente.")
        await websocket.close(code=1008, reason="Token de autenticacao invalido")
        return
    await ws_manager.connect(websocket)
    try:
        # Estado atual para o novo cliente (ex: serial conectada antes da pagina abrir)
        await ws_manager.send_message(json.dumps({
            "type": "HARDWARE_STATUS",
            "payload": {
                "connected": serial_manager.connected,
                "responsive": serial_manager.is_responsive(),
            },
        }), websocket)

        while True:
            data = await websocket.receive_text()
            await ws_manager.handle_message(data, websocket)
    except WebSocketDisconnect:
        await ws_manager.disconnect_async(websocket)
    except Exception as e:
        logger.error(f"Erro no WebSocket: {e}")
        await ws_manager.disconnect_async(websocket)

@app.get("/api/status")
def get_status():
    return {
        "serial_connected": serial_manager.connected,
        "serial_responsive": serial_manager.is_responsive(),
        "serial_last_response_age_s": serial_manager.last_response_age_s(),
        "active_ws_connections": len(ws_manager.active_connections),
        "safety_state": safety_manager.current_state,
        "detector_session": state_store.get_detector(),
    }

CLIENT_ERRORS_LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client_errors.log")
# Tamanho maximo do arquivo de log para evitar DoS por preenchimento de disco.
CLIENT_ERRORS_LOG_MAX_BYTES = 500_000

def _sanitize_log_field(value: str) -> str:
    """Remove caracteres de controle / linhas para evitar log injection."""
    return "".join(c for c in value if c.isprintable() or c in "\n\t").strip()

def _ensure_client_log_size():
    """Trunca o log de erros para nao crescer indefinidamente (ring buffer)."""
    try:
        if os.path.exists(CLIENT_ERRORS_LOG) and os.path.getsize(CLIENT_ERRORS_LOG) > CLIENT_ERRORS_LOG_MAX_BYTES:
            with open(CLIENT_ERRORS_LOG, "r+", encoding="utf-8") as f:
                f.seek(os.path.getsize(CLIENT_ERRORS_LOG) - CLIENT_ERRORS_LOG_MAX_BYTES)
                tail = f.read()
                f.seek(0)
                f.truncate()
                f.write(tail)
    except Exception:
        pass

@app.post("/api/client-error")
async def log_client_error(request: Request):
    """Recebe relatorios de erro do frontend (diagnostico mobile)."""
    try:
        raw = await request.body()
        if len(raw) > 16_000:
            return {"ok": False, "error": "body_too_large"}
        body = await request.json()
    except Exception:
        body = {}
    message = _sanitize_log_field(str(body.get("message", "")))[:2000]
    stack = _sanitize_log_field(str(body.get("stack", "")))[:4000]
    context = _sanitize_log_field(str(body.get("context", "")))[:200]
    ua = _sanitize_log_field(str(body.get("userAgent", "")))[:300]
    _ensure_client_log_size()
    with open(CLIENT_ERRORS_LOG, "a", encoding="utf-8") as f:
        f.write(f"=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        f.write(f"UA: {ua}\n")
        f.write(f"Contexto: {context}\n")
        f.write(f"Erro: {message}\n")
        f.write(f"Stack:\n{stack}\n\n")
    logger.info(f"Erro de cliente registrado: {context} -> {message[:200]}")
    return {"ok": True}

@app.post("/api/hardware/test/{command}")
def test_hardware(command: str, _: None = Depends(require_rest_auth)):
    """Endpoints de teste: ALARM, VIBRATION, OFF"""
    safety_manager.test_hardware(command)
    return {"status": "ok", "command": command}

@app.post("/api/hardware/connect")
def connect_hardware(port: str = None, _: None = Depends(require_rest_auth)):
    success = serial_manager.connect(port)
    return {"success": success}

@app.post("/api/hardware/disconnect")
def disconnect_hardware(_: None = Depends(require_rest_auth)):
    serial_manager.disconnect()
    return {"success": True}
