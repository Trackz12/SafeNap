import json
import logging
from typing import Dict, Any
from fastapi import WebSocket

from app.core.protocol import WebSocketMessage, EventType
from app.safety.manager import safety_manager

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Cliente conectado. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Cliente desconectado. Total: {len(self.active_connections)}")
            if not self.active_connections:
                safety_manager.on_all_clients_disconnected()

    async def send_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Erro ao enviar broadcast: {e}")

    async def handle_message(self, text_data: str, websocket: WebSocket):
        try:
            data = json.loads(text_data)
            msg = WebSocketMessage(**data)
            logger.debug(f"Recebido: {msg.type} de {msg.session_id}")
            
            # Encaminha eventos de segurança para o SafetyManager
            safety_events = [
                EventType.DROWSINESS_STARTED,
                EventType.DROWSINESS_ENDED,
                EventType.DROWSINESS_WARNING,
                EventType.DROWSINESS_WARNING_ENDED,
                EventType.ALARM_ACKNOWLEDGED,
                EventType.HEARTBEAT,
                EventType.FACE_LOST,
                EventType.FACE_DETECTED,
            ]
            if msg.type in safety_events:
                safety_manager.process_event(msg)
                
        except Exception as e:
            logger.error(f"Erro ao processar mensagem: {e} | Conteúdo: {text_data}")

ws_manager = ConnectionManager()
