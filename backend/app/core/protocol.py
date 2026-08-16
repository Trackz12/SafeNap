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
    ERROR = "ERROR"

class WebSocketMessage(BaseModel):
    type: EventType
    timestamp: float
    session_id: str
    payload: Optional[Dict[str, Any]] = None

class SafetyState(str, Enum):
    NORMAL = "NORMAL"
    WARNING = "WARNING"
    ALARM = "ALARM"
