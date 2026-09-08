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

# Severidade para combinar as duas fontes de sinal (visao + garra) em OR:
# o estado efetivo e sempre o mais severo entre as duas.
_SEVERITY = {SafetyState.NORMAL: 0, SafetyState.WARNING: 1, SafetyState.ALARM: 2}


class SafetyManager:
    def __init__(self):
        # Duas fontes independentes de sinal, fundidas em OR (a mais severa
        # vence). Fundir por "ultimo evento vence" quebraria a garantia de
        # robustez: um DROWSINESS_WARNING_ENDED do frontend nao pode apagar
        # um ALARM que veio da queda de pressao no volante, e vice-versa.
        self._vision_state: SafetyState = SafetyState.NORMAL
        self._grip_state: SafetyState = SafetyState.NORMAL
        self.current_state: SafetyState = SafetyState.NORMAL
        self._watchdog: threading.Timer | None = None
        self._lock = threading.Lock()
        # True quando o watchdog desligou o hardware mas o estado ainda e ALARM.
        # Permite reaplicar o hardware quando o frontend voltar sem virar NORMAL.
        self._hardware_silenced = False

    def process_event(self, event: WebSocketMessage):
        """Avalia um evento vindo do frontend (visao/ML) e atualiza a fonte
        de sinal correspondente. Nao mexe no sinal de garra."""
        with self._lock:
            if event.type == EventType.DROWSINESS_STARTED:
                self._vision_state = SafetyState.ALARM

            elif event.type == EventType.DROWSINESS_ENDED:
                self._vision_state = SafetyState.NORMAL

            elif event.type == EventType.DROWSINESS_WARNING:
                if self._vision_state != SafetyState.ALARM:
                    self._vision_state = SafetyState.WARNING

            elif event.type == EventType.DROWSINESS_WARNING_ENDED:
                self._vision_state = SafetyState.NORMAL

            elif event.type == EventType.ALARM_ACKNOWLEDGED:
                # Usuario confirmou que esta acordado/com as maos no volante:
                # zera as duas fontes, nao so a de visao.
                self._vision_state = SafetyState.NORMAL
                self._grip_state = SafetyState.NORMAL

            self._recompute_state()

    def process_grip_signal(self, state: SafetyState):
        """Atualiza a fonte de sinal do sensor de pressao FSR (GripMonitor).
        Nao mexe no sinal de visao/ML."""
        with self._lock:
            self._grip_state = state
            self._recompute_state()

    def _recompute_state(self):
        """Recalcula o estado efetivo (o mais severo entre visao e garra) e
        reaplica o hardware/watchdog se necessario. Deve ser chamado sempre
        dentro de self._lock."""
        previous_state = self.current_state
        self.current_state = max(
            self._vision_state, self._grip_state, key=lambda s: _SEVERITY[s]
        )

        new_alarm = self.current_state == SafetyState.ALARM
        was_silenced_while_alarm = self._hardware_silenced and new_alarm

        if self.current_state != previous_state or was_silenced_while_alarm:
            self._hardware_silenced = False
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
            self._vision_state = SafetyState.NORMAL
            self._grip_state = SafetyState.NORMAL
            self.current_state = SafetyState.NORMAL
            self._hardware_silenced = False
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
        with self._lock:
            if self.current_state in (SafetyState.ALARM, SafetyState.WARNING):
                self._hardware_silenced = True
        logger.warning("Watchdog: sem eventos durante alerta; desligando hardware por seguranca.")
        serial_manager.send_command("ALARM_OFF")
        serial_manager.send_command("VIBRATION_OFF")

    def _apply_hardware_state(self):
        """Traduz o estado de seguranca atual para comandos do Arduino."""
        logger.info(f"Tentativa de reaplicar hardware (silenced={self._hardware_silenced}): {self.current_state}")
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
