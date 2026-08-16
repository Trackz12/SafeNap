import logging
import threading
from app.core.protocol import WebSocketMessage, EventType, SafetyState
from app.serial.manager import serial_manager

logger = logging.getLogger(__name__)

# Timeout de seguranca: se nenhum evento de seguranca chegar do frontend
# enquanto um alerta estiver ativo (aba fechada, crash do navegador, JS travado),
# o hardware eh desligado automaticamente para nao deixar buzzer/vibracao
# ligados para sempre. O frontend envia heartbeat a cada 3s durante ALARM,
# renovando o watchdog enquanto a deteccao estiver viva.
ALARM_HARDWARE_TIMEOUT_S = 15

class SafetyManager:
    def __init__(self):
        self.current_state: SafetyState = SafetyState.NORMAL
        self._watchdog: threading.Timer | None = None
        self._lock = threading.Lock()

    def process_event(self, event: WebSocketMessage):
        """Avalia um evento e determina se o estado de seguranca deve mudar."""
        with self._lock:
            previous_state = self.current_state

            if event.type == EventType.DROWSINESS_STARTED:
                self.current_state = SafetyState.ALARM

            elif event.type == EventType.DROWSINESS_ENDED:
                self.current_state = SafetyState.NORMAL

            elif event.type == EventType.DROWSINESS_WARNING:
                if self.current_state != SafetyState.ALARM:
                    self.current_state = SafetyState.WARNING

            elif event.type in (EventType.DROWSINESS_WARNING_ENDED, EventType.ALARM_ACKNOWLEDGED):
                self.current_state = SafetyState.NORMAL

            if self.current_state != previous_state:
                self._apply_hardware_state()

            # Qualquer evento renovando o watchdog: a deteccao esta viva
            if self.current_state in (SafetyState.ALARM, SafetyState.WARNING):
                self._rearm_watchdog()
            else:
                self._cancel_watchdog()

    def on_all_clients_disconnected(self):
        """Se nenhum cliente estiver mais conectado, nao ha deteccao ativa:
        desliga o hardware por seguranca."""
        with self._lock:
            logger.info("Todos os clientes desconectados: desligando hardware de alerta.")
            self._cancel_watchdog()
            self.current_state = SafetyState.NORMAL
            serial_manager.send_command("ALARM_OFF")
            serial_manager.send_command("VIBRATION_OFF")

    def _rearm_watchdog(self):
        self._cancel_watchdog()
        self._watchdog = threading.Timer(ALARM_HARDWARE_TIMEOUT_S, self._watchdog_silence)
        self._watchdog.daemon = True
        self._watchdog.start()

    def _cancel_watchdog(self):
        if self._watchdog is not None:
            self._watchdog.cancel()
            self._watchdog = None

    def _watchdog_silence(self):
        """Desliga o hardware se os eventos pararam de chegar durante um alerta."""
        logger.warning("Watchdog: sem eventos durante alerta; desligando hardware por seguranca.")
        serial_manager.send_command("ALARM_OFF")
        serial_manager.send_command("VIBRATION_OFF")

    def _apply_hardware_state(self):
        """Traduz o estado de seguranca atual para comandos do Arduino."""
        logger.info(f"Mudanca de estado: {self.current_state}")
        if self.current_state == SafetyState.ALARM:
            serial_manager.send_command("ALARM_ON")
        elif self.current_state == SafetyState.WARNING:
            serial_manager.send_command("VIBRATION_ON")
        elif self.current_state == SafetyState.NORMAL:
            serial_manager.send_command("ALARM_OFF")
            serial_manager.send_command("VIBRATION_OFF")

    def test_hardware(self, test_type: str):
        """Manda um comando de teste (via requisicao de UI)."""
        if test_type == "ALARM":
            serial_manager.send_command("ALARM_ON")
        elif test_type == "VIBRATION":
            serial_manager.send_command("VIBRATION_ON")
        elif test_type == "OFF":
            serial_manager.send_command("ALARM_OFF")
            serial_manager.send_command("VIBRATION_OFF")

safety_manager = SafetyManager()
