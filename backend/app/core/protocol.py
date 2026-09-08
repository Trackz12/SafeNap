from pydantic import BaseModel
from typing import Optional, Dict, Any
from enum import Enum

class EventType(str, Enum):
    FACE_DETECTED = "FACE_DETECTED"
    FACE_LOST = "FACE_LOST"
    EYES_OPEN = "EYES_OPEN"
    EYES_CLOSED = "EYES_CLOSED"
    YAWN_DETECTED = "YAWN_DETECTED"
    HEAD_DROPPED = "HEAD_DROPPED"
    DROWSINESS_WARNING = "DROWSINESS_WARNING"
    DROWSINESS_WARNING_ENDED = "DROWSINESS_WARNING_ENDED"
    DROWSINESS_STARTED = "DROWSINESS_STARTED"
    DROWSINESS_ENDED = "DROWSINESS_ENDED"
    ALARM_ACKNOWLEDGED = "ALARM_ACKNOWLEDGED"
    HEARTBEAT = "HEARTBEAT"
    HARDWARE_STATUS = "HARDWARE_STATUS"
    GRIP_STATUS = "GRIP_STATUS"  # backend -> frontend: estado do sensor FSR (empunhadura)
    ERROR = "ERROR"

    # --- Sincronização multi-dispositivo (detector -> backend -> viewers) ---
    # O device que roda a câmera é o "detector"; os demais são "viewers" e
    # apenas espelham métricas/estado. Frames de vídeo NUNCA passam pelo WS.
    DETECTOR_CLAIM = "DETECTOR_CLAIM"        # device pede papel de detector
    DETECTOR_RELEASE = "DETECTOR_RELEASE"    # detector abre mão do papel (câmera parada)
    DETECTOR_TAKEN = "DETECTOR_TAKEN"        # backend: outro device já é detector
    DETECTOR_ASSIGNED = "DETECTOR_ASSIGNED"  # backend: claim aceito
    DETECTOR_CLEARED = "DETECTOR_CLEARED"    # backend: detector desconectou
    METRICS_UPDATE = "METRICS_UPDATE"        # métricas derivadas (EAR, PERCLOS...)
    SESSION_SYNC = "SESSION_SYNC"            # snapshot de sessão (contadores/histórico)
    CALIBRATION_SYNC = "CALIBRATION_SYNC"    # calibração FINAL persistida e compartilhada
    CALIBRATION_PROGRESS = "CALIBRATION_PROGRESS"  # progresso ao vivo da calibração
    CALIBRATION_REQUEST = "CALIBRATION_REQUEST"    # viewer pede calibração ao detector
    MODEL_SYNC = "MODEL_SYNC"                # modelo RF do usuário treinado
    STATE_SNAPSHOT = "STATE_SNAPSHOT"        # backend -> cliente recém-conectado

class WebSocketMessage(BaseModel):
    type: EventType
    timestamp: float
    session_id: str
    payload: Optional[Dict[str, Any]] = None

class SafetyState(str, Enum):
    NORMAL = "NORMAL"
    WARNING = "WARNING"
    ALARM = "ALARM"
