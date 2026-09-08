"""Testes do SafetyManager — máquina de estados que controla o hardware.

O serial_manager é mockado para capturar os comandos sem hardware real.
Cobre: transições de estado, aplicação de hardware, watchdog (silêncio e
re-arm após queda de rede) e desconexão total de clientes.
"""
from unittest.mock import patch
from app.safety.manager import SafetyManager
from app.core.protocol import WebSocketMessage, EventType, SafetyState


def make_event(event_type: EventType) -> WebSocketMessage:
    return WebSocketMessage(
        type=event_type, timestamp=0.0, session_id="test-session"
    )


class CommandLog:
    """Captura comandos enviados ao serial_manager em vez de hardware real."""

    def __init__(self):
        self.commands = []

    def send_command(self, command: str) -> bool:
        self.commands.append(command)
        return True


def fresh_manager() -> tuple[SafetyManager, CommandLog]:
    """Cria um SafetyManager com serial mockado e log de comandos."""
    manager = SafetyManager()
    log = CommandLog()
    # Substitui o serial_manager global dentro do módulo do SafetyManager
    with patch("app.safety.manager.serial_manager", log):
        pass
    return manager, log


class TestSafetyManagerStates:
    def test_starts_normal(self):
        manager, _ = fresh_manager()
        assert manager.current_state == SafetyState.NORMAL

    def test_drowsiness_started_goes_alarm(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_STARTED))
        assert manager.current_state == SafetyState.ALARM

    def test_drowsiness_ended_goes_normal(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_STARTED))
        manager.process_event(make_event(EventType.DROWSINESS_ENDED))
        assert manager.current_state == SafetyState.NORMAL

    def test_warning_from_normal(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_WARNING))
        assert manager.current_state == SafetyState.WARNING

    def test_warning_does_not_downgrade_alarm(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_STARTED))
        manager.process_event(make_event(EventType.DROWSINESS_WARNING))
        assert manager.current_state == SafetyState.ALARM

    def test_alarm_acknowledged_goes_normal(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_STARTED))
        manager.process_event(make_event(EventType.ALARM_ACKNOWLEDGED))
        assert manager.current_state == SafetyState.NORMAL

    def test_warning_ended_goes_normal(self):
        manager, _ = fresh_manager()
        manager.process_event(make_event(EventType.DROWSINESS_WARNING))
        manager.process_event(make_event(EventType.DROWSINESS_WARNING_ENDED))
        assert manager.current_state == SafetyState.NORMAL


class TestHardwareApplication:
    def test_alarm_applies_alarm_on(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            mock_serial.send_command.assert_any_call("ALARM_ON")

    def test_warning_applies_vibration_on(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_WARNING))
            mock_serial.send_command.assert_any_call("VIBRATION_ON")

    def test_normal_applies_all_off(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            mock_serial.send_command.reset_mock()
            manager.process_event(make_event(EventType.DROWSINESS_ENDED))
            mock_serial.send_command.assert_any_call("ALARM_OFF")
            mock_serial.send_command.assert_any_call("VIBRATION_OFF")

    def test_same_state_transition_does_not_reapply(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            # Primeiro ALARM aplica hardware
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            assert mock_serial.send_command.call_count == 1
            # Segundo DROWSINESS_STARTED (mesmo estado) NÃO reaplica
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            assert mock_serial.send_command.call_count == 1

    def test_all_clients_disconnected_turns_off(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager.on_all_clients_disconnected()
            assert manager.current_state == SafetyState.NORMAL
            mock_serial.send_command.assert_any_call("ALARM_OFF")
            mock_serial.send_command.assert_any_call("VIBRATION_OFF")


class TestWatchdog:
    def test_watchdog_armed_on_alarm(self):
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            assert manager._watchdog is not None

    def test_watchdog_cancelled_on_normal(self):
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager.process_event(make_event(EventType.DROWSINESS_ENDED))
            assert manager._watchdog is None

    def test_watchdog_silence_sets_hardware_silenced_flag(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager._watchdog_silence()
            # Hardware silenciado durante ALARM -> flag setada
            assert manager._hardware_silenced is True
            # E os comandos de desligar foram enviados
            mock_serial.send_command.assert_any_call("ALARM_OFF")
            mock_serial.send_command.assert_any_call("VIBRATION_OFF")

    def test_watchdog_silence_not_flagged_in_normal(self):
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager._watchdog_silence()
            # Estado NORMAL -> não seta flag (não há alarme para re-armar)
            assert manager._hardware_silenced is False

    def test_rearm_after_watchdog_silence_on_new_alarm_event(self):
        """Cobertura do fix: após watchdog silenciar o hardware durante ALARM,
        um novo evento de alarme (ex: reconexão) deve REAPLICAR o hardware,
        mesmo sem transição de estado."""
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            mock_serial.send_command.reset_mock()

            # Watchdog silencia (queda de rede > 15s)
            manager._watchdog_silence()
            assert manager._hardware_silenced is True

            # Reconexão: DROWSINESS_STARTED re-enviado (mesmo estado ALARM)
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            # Hardware deve ter sido reaplicado
            mock_serial.send_command.assert_any_call("ALARM_ON")
            assert manager._hardware_silenced is False


class TestGripFusion:
    """Fusao OR entre o sinal de visao (frontend) e o sinal de garra
    (GripMonitor/FSR): o estado efetivo e sempre o mais severo dos dois,
    e um evento de "fim" de uma fonte nao pode apagar um alarme ainda
    ativo na outra fonte."""

    def test_grip_alarm_alone_raises_current_state(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.process_grip_signal(SafetyState.ALARM)
            assert manager.current_state == SafetyState.ALARM
            mock_serial.send_command.assert_any_call("ALARM_ON")

    def test_vision_alarm_survives_grip_recovering(self):
        """Regressao do bug identificado no plano: mao volta ao volante
        (grip -> NORMAL) nao pode apagar um ALARM de sonolencia ocular
        ainda ativo vindo da visao."""
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager.process_grip_signal(SafetyState.WARNING)
            manager.process_grip_signal(SafetyState.NORMAL)
            assert manager.current_state == SafetyState.ALARM

    def test_grip_alarm_survives_vision_ending(self):
        """Simetrico: olhos reabrem (visao -> NORMAL) nao apaga um ALARM
        de queda de pressao no volante ainda ativo."""
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_grip_signal(SafetyState.ALARM)
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager.process_event(make_event(EventType.DROWSINESS_ENDED))
            assert manager.current_state == SafetyState.ALARM

    def test_current_state_drops_only_when_both_sources_clear(self):
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_event(make_event(EventType.DROWSINESS_WARNING))
            manager.process_grip_signal(SafetyState.WARNING)
            manager.process_event(make_event(EventType.DROWSINESS_WARNING_ENDED))
            assert manager.current_state == SafetyState.WARNING
            manager.process_grip_signal(SafetyState.NORMAL)
            assert manager.current_state == SafetyState.NORMAL

    def test_alarm_acknowledged_clears_both_sources(self):
        with patch("app.safety.manager.serial_manager"):
            manager = SafetyManager()
            manager.process_grip_signal(SafetyState.ALARM)
            manager.process_event(make_event(EventType.DROWSINESS_STARTED))
            manager.process_event(make_event(EventType.ALARM_ACKNOWLEDGED))
            assert manager.current_state == SafetyState.NORMAL
            # Uma nova leitura de garra "sem mudanca" (NORMAL) nao deve reacender nada
            manager.process_grip_signal(SafetyState.NORMAL)
            assert manager.current_state == SafetyState.NORMAL


class TestHardwareTestCommands:
    def test_alarm_test(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.test_hardware("ALARM")
            mock_serial.send_command.assert_called_once_with("ALARM_ON")

    def test_vibration_test(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.test_hardware("VIBRATION")
            mock_serial.send_command.assert_called_once_with("VIBRATION_ON")

    def test_off_test(self):
        with patch("app.safety.manager.serial_manager") as mock_serial:
            manager = SafetyManager()
            manager.test_hardware("OFF")
            assert mock_serial.send_command.call_count == 2
