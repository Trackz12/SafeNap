import asyncio
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os
import time

from app.websocket.manager import ws_manager
from app.serial.manager import serial_manager
from app.safety.manager import safety_manager
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
        msg = {"type": "HARDWARE_STATUS", "payload": {"connected": connected}}
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
# Permite qualquer subdomínio tailscale
CORS_ORIGINS.append("https://desktop-jvtc5nv.tail15c9a8.ts.net")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        # Estado atual para o novo cliente (ex: serial conectada antes da pagina abrir)
        await ws_manager.send_message(json.dumps({
            "type": "HARDWARE_STATUS",
            "payload": {"connected": serial_manager.connected},
        }), websocket)

        while True:
            data = await websocket.receive_text()
            await ws_manager.handle_message(data, websocket)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Erro no WebSocket: {e}")
        ws_manager.disconnect(websocket)

@app.get("/api/status")
def get_status():
    return {
        "serial_connected": serial_manager.connected,
        "active_ws_connections": len(ws_manager.active_connections),
        "safety_state": safety_manager.current_state
    }

CLIENT_ERRORS_LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client_errors.log")

@app.post("/api/client-error")
async def log_client_error(request: Request):
    """Recebe relatorios de erro do frontend (diagnostico mobile)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = str(body.get("message", ""))[:2000]
    stack = str(body.get("stack", ""))[:4000]
    context = str(body.get("context", ""))[:200]
    ua = str(body.get("userAgent", ""))[:300]
    with open(CLIENT_ERRORS_LOG, "a", encoding="utf-8") as f:
        f.write(f"=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        f.write(f"UA: {ua}\n")
        f.write(f"Contexto: {context}\n")
        f.write(f"Erro: {message}\n")
        f.write(f"Stack:\n{stack}\n\n")
    logger.info(f"Erro de cliente registrado: {context} -> {message[:200]}")
    return {"ok": True}

@app.post("/api/hardware/test/{command}")
def test_hardware(command: str):
    """Endpoints de teste: ALARM, VIBRATION, OFF"""
    safety_manager.test_hardware(command)
    return {"status": "ok", "command": command}

@app.post("/api/hardware/connect")
def connect_hardware(port: str = None):
    success = serial_manager.connect(port)
    return {"success": success}

@app.post("/api/hardware/disconnect")
def disconnect_hardware():
    serial_manager.disconnect()
    return {"success": True}
