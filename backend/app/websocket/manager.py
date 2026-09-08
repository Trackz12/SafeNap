import json
import logging
from typing import Dict, Optional
from fastapi import WebSocket

from app.core.protocol import WebSocketMessage, EventType
from app.core.state_store import state_store
from app.safety.manager import safety_manager

logger = logging.getLogger(__name__)

# Limite de tamanho por mensagem WS. O maior payload legítimo é MODEL_SYNC
# (Random Forest de usuário serializado, ~40 árvores rasas — bem menor que
# isso na prática); generoso o bastante para nunca barrar uso real, mas
# evita que uma mensagem gigante ou malformada seja parseada e, no caso de
# CALIBRATION_SYNC/MODEL_SYNC, persistida em disco repetidamente. Mesmo
# princípio já aplicado ao body de POST /api/client-error (16KB).
MAX_MESSAGE_BYTES = 512 * 1024

# Eventos que o detector envia para o backend apenas como SINK de hardware.
SAFETY_EVENTS = {
    EventType.DROWSINESS_STARTED,
    EventType.DROWSINESS_ENDED,
    EventType.DROWSINESS_WARNING,
    EventType.DROWSINESS_WARNING_ENDED,
    EventType.ALARM_ACKNOWLEDGED,
    EventType.HEARTBEAT,
    EventType.FACE_LOST,
    EventType.FACE_DETECTED,
}

# Eventos que o detector publica e o backend reencaminha para os demais
# clientes (viewers). Nunca contém frames de vídeo.
SYNC_EVENTS = {
    EventType.METRICS_UPDATE,
    EventType.SESSION_SYNC,
    EventType.CALIBRATION_SYNC,
    EventType.MODEL_SYNC,
    EventType.CALIBRATION_PROGRESS,
}

# Mapeia o tipo do evento para a chave usada no StateStore.
STORE_KEY = {
    EventType.METRICS_UPDATE: "metrics",
    EventType.SESSION_SYNC: "session",
    EventType.CALIBRATION_SYNC: "calibration",
    EventType.MODEL_SYNC: "user_model",
}


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        # websocket -> session_id (do último DETECTOR_CLAIM recebido).
        # Usado só para exibição/bookkeeping (ex: `owner` no DETECTOR_TAKEN,
        # `detector_session` no /api/status) -- NUNCA para decidir permissão,
        # porque é um valor autodeclarado pelo cliente a cada mensagem.
        self._session_ids: Dict[WebSocket, str] = {}
        # Conexão que efetivamente detém o papel de detector. Fonte da
        # verdade para autorizar SAFETY_EVENTS/SYNC_EVENTS/DETECTOR_RELEASE:
        # a identidade do objeto WebSocket não pode ser forjada por um
        # cliente (diferente do `session_id`, que é só uma string que o
        # próprio cliente escolhe e pode repetir para se passar pelo
        # detector real).
        self._detector_connection: Optional[WebSocket] = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Cliente conectado. Total: {len(self.active_connections)}")
        await self.send_initial_state(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Cliente desconectado. Total: {len(self.active_connections)}")
            session_id = self._session_ids.pop(websocket, None)
            if websocket is self._detector_connection:
                # O detector se desconectou: libera o papel para outro device.
                self._detector_connection = None
                state_store.release_detector(session_id or "")
                state_store.clear_live()
                logger.info(f"Detector {session_id} liberado (desconexão).")
                # Fire-and-forget: nao ha event loop no contexto de disconnect
                # alem deste, entao agendamos o broadcast no proprio handler.
            if not self.active_connections:
                safety_manager.on_all_clients_disconnected()

    async def disconnect_async(self, websocket: WebSocket):
        """Desconecta e, se o detector saiu, avisa os demais via broadcast."""
        was_detector = websocket is self._detector_connection
        self.disconnect(websocket)
        if was_detector and self.active_connections:
            await self.broadcast(json.dumps({
                "type": "DETECTOR_CLEARED",
                "timestamp": 0,
                "session_id": "server",
                "payload": {},
            }))

    async def send_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str, exclude: Optional[WebSocket] = None):
        for connection in self.active_connections:
            if connection is exclude:
                continue
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Erro ao enviar broadcast: {e}")

    async def send_initial_state(self, websocket: WebSocket):
        """Estado compartilhado atual para quem acabou de conectar."""
        hello = {
            "type": "STATE_SNAPSHOT",
            "timestamp": 0,
            "session_id": "server",
            "payload": state_store.snapshot(),
        }
        try:
            await websocket.send_text(json.dumps(hello))
        except Exception as e:
            logger.error(f"Erro ao enviar estado inicial: {e}")

    async def handle_message(self, text_data: str, websocket: WebSocket):
        if len(text_data.encode("utf-8")) > MAX_MESSAGE_BYTES:
            logger.warning(
                f"Mensagem WS descartada: {len(text_data)} caracteres excede "
                f"o limite de {MAX_MESSAGE_BYTES} bytes."
            )
            return
        try:
            data = json.loads(text_data)
            msg = WebSocketMessage(**data)
            logger.debug(f"Recebido: {msg.type} de {msg.session_id}")

            # Registra o session_id da conexao (para liberar detector no close)
            self._session_ids[websocket] = msg.session_id

            # --- Negociação de papel de detector ---
            if msg.type == EventType.DETECTOR_CLAIM:
                await self._handle_claim(msg, websocket)
                return

            if msg.type == EventType.DETECTOR_RELEASE:
                # So a propria conexao detentora pode liberar o papel --
                # um session_id forjado nao basta (ver _detector_connection).
                if websocket is self._detector_connection:
                    self._detector_connection = None
                    state_store.release_detector(msg.session_id)
                    state_store.clear_live()
                    logger.info(f"Detector {msg.session_id} liberou o papel voluntariamente.")
                    await self.broadcast(json.dumps({
                        "type": "DETECTOR_CLEARED",
                        "timestamp": msg.timestamp,
                        "session_id": "server",
                        "payload": {},
                    }), exclude=websocket)
                return

            # --- Pedido de calibração vindo de um viewer ---
            # Roteado diretamente ao device com papel de detector.
            if msg.type == EventType.CALIBRATION_REQUEST:
                await self._route_to_detector(text_data)
                return

            # --- Eventos de segurança: sink para o SafetyManager/hardware ---
            # Só a conexão que É o detector pode gerar esses eventos --
            # caso contrário qualquer viewer (ou dispositivo mal-
            # comportado na mesma rede/token) poderia mandar
            # ALARM_ACKNOWLEDGED e silenciar o alarme real de outra
            # pessoa, ou DROWSINESS_ENDED e mascarar sonolência ativa.
            if msg.type in SAFETY_EVENTS:
                if websocket is not self._detector_connection:
                    logger.warning(
                        f"Evento de segurança '{msg.type}' ignorado: conexão "
                        f"não é o detector atual (session_id declarado: {msg.session_id})."
                    )
                    return
                safety_manager.process_event(msg)
                return

            # --- Eventos de sincronização: persistir e reencaminhar ---
            # Mesma checagem: só o detector pode publicar métricas/
            # calibração/modelo. Sem isso, qualquer conexão poderia
            # forjar CALIBRATION_SYNC/MODEL_SYNC e sobrescrever o estado
            # persistido (`safenap_shared.json`) para todos os viewers.
            if msg.type in SYNC_EVENTS:
                if websocket is not self._detector_connection:
                    logger.warning(
                        f"Evento de sincronização '{msg.type}' ignorado: conexão "
                        f"não é o detector atual (session_id declarado: {msg.session_id})."
                    )
                    return
                # Extrair payload interno: o frontend envia { metrics: m },
                # { session: s }, { model: m } etc. — precisamos gravar
                # apenas o valor, não o wrapper, para que o STATE_SNAPSHOT
                # entregue o dado plano ao viewer.
                raw = msg.payload
                inner = raw
                if isinstance(raw, dict) and len(raw) == 1:
                    inner = next(iter(raw.values()))
                state_store.update(STORE_KEY[msg.type], inner)
                await self.broadcast(text_data, exclude=websocket)
                return

        except Exception as e:
            logger.error(f"Erro ao processar mensagem: {e} | Conteúdo: {text_data}")

    async def _route_to_detector(self, text_data: str):
        """Encaminha uma mensagem ao device que detém o papel de detector."""
        if self._detector_connection is None:
            return
        try:
            await self._detector_connection.send_text(text_data)
        except Exception as e:
            logger.error(f"Erro ao rotear para o detector: {e}")

    async def _handle_claim(self, msg: WebSocketMessage, websocket: WebSocket):
        """Primeiro claim vence; demais recebem DETECTOR_TAKEN.

        A decisão de conceder o papel usa a identidade da própria conexão
        (`self._detector_connection`), não o `session_id` autodeclarado:
        um viewer poderia mandar DETECTOR_CLAIM com o mesmo session_id do
        detector atual para tentar sequestrar a vaga."""
        session_id = msg.session_id
        if self._detector_connection is None or self._detector_connection is websocket:
            self._detector_connection = websocket
            state_store.claim_detector(session_id)
            self._session_ids[websocket] = session_id
            ack = {
                "type": "DETECTOR_ASSIGNED",
                "timestamp": msg.timestamp,
                "session_id": "server",
                "payload": {"owner": session_id},
            }
            await self.send_message(json.dumps(ack), websocket)
            await self.broadcast(
                json.dumps({
                    "type": "DETECTOR_TAKEN",
                    "timestamp": msg.timestamp,
                    "session_id": "server",
                    "payload": {"owner": session_id},
                }),
                exclude=websocket,
            )
        else:
            current = state_store.get_detector()
            nack = {
                "type": "DETECTOR_TAKEN",
                "timestamp": msg.timestamp,
                "session_id": "server",
                "payload": {"owner": current},
            }
            await self.send_message(json.dumps(nack), websocket)


ws_manager = ConnectionManager()
