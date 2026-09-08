"""Testes do GripMonitor — sinal de pressao FSR-402 (empunhadura do volante).

Hardware real: UM sensor FSR-402 no pino A0 (confirmado pelo firmware
historico usado nas simulacoes originais do TCC — nao dois sensores).
Sem hardware real: o canal analogico e simulado por valores fixos. O
clock e injetavel para testar o debounce temporal sem depender de sleep
real (mesmo padrao de isolamento ja usado nos testes do SafetyManager,
que mocka o serial_manager).
"""
from unittest.mock import patch

from app.safety.grip_monitor import GripMonitor
from app.core.protocol import SafetyState


class FakeClock:
    """Clock controlavel manualmente para testar debounce sem sleep real."""

    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


BASELINE_PRESSURE = 600.0
DROPPED_PRESSURE = 50.0  # bem abaixo de 35% de 600 (limiar de queda)


def calibrate(monitor: GripMonitor, clock: FakeClock, pressure: float = BASELINE_PRESSURE) -> None:
    """Alimenta amostras suficientes para sair do estado 'ainda calibrando'."""
    for _ in range(GripMonitor.MIN_BASELINE_SAMPLES + 1):
        monitor.update(pressure)
        clock.advance(0.2)


class TestBaseline:
    def test_not_calibrated_before_min_samples(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            monitor.update(BASELINE_PRESSURE)
        assert monitor.status()["calibrated"] is False

    def test_calibrated_after_min_samples(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
        assert monitor.status()["calibrated"] is True

    def test_baseline_frozen_while_grip_lost(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            baseline_before = monitor.status()["baseline"]
            monitor.update(DROPPED_PRESSURE)
            clock.advance(0.2)
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["baseline"] == baseline_before

    def test_baseline_resumes_tracking_after_recovery(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            baseline_before = monitor.status()["baseline"]
            monitor.update(DROPPED_PRESSURE)
            recovered = BASELINE_PRESSURE * 1.2
            monitor.update(recovered)
        assert monitor.status()["baseline"] != baseline_before


class TestDropDetection:
    def test_stays_normal_on_brief_drop(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["state"] == SafetyState.NORMAL
        assert monitor.status()["gripped"] is False

    def test_warning_after_sustained_drop(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(0.6)
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["state"] == SafetyState.WARNING

    def test_alarm_after_long_sustained_drop(self):
        """O limiar de ALARM (1s) replica a tolerancia usada no firmware
        historico (`tempoTolerancia = 1000` ms) que disparava o alerta
        original nas simulacoes do TCC."""
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(1.1)
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["state"] == SafetyState.ALARM

    def test_hysteresis_requires_recovery_above_recover_ratio(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(0.6)
            monitor.update(DROPPED_PRESSURE)
            assert monitor.status()["state"] == SafetyState.WARNING

            # Pressao sobe mas ainda abaixo do limiar de recuperacao (60%)
            partial = BASELINE_PRESSURE * 0.45
            monitor.update(partial)
            assert monitor.status()["gripped"] is False

            # Agora acima do limiar de recuperacao
            recovered = BASELINE_PRESSURE * 0.65
            monitor.update(recovered)
        assert monitor.status()["gripped"] is True
        assert monitor.status()["state"] == SafetyState.NORMAL

    def test_insufficient_samples_never_flags_drop(self):
        """Sem baseline calibrada, uma leitura baixa isolada nao deve virar alarme."""
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            monitor.update(DROPPED_PRESSURE)
            clock.advance(5.0)
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["calibrated"] is False
        mock_safety.process_grip_signal.assert_not_called()

    def test_no_automatic_alarm_cutoff(self):
        """Diferente do firmware historico (`tempoMaximoAlerta` desligava o
        alerta apos 10s mesmo sem a mao voltar ao volante), o GripMonitor
        atual NAO limita a duracao do alarme: enquanto a queda persistir, o
        estado continua ALARM indefinidamente — desligar um alerta de
        seguranca sozinho, sem confirmacao do usuario, seria um regresso."""
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(30.0)  # bem alem dos 10s do firmware antigo
            monitor.update(DROPPED_PRESSURE)
        assert monitor.status()["state"] == SafetyState.ALARM


class TestSafetyManagerIntegration:
    def test_calls_safety_manager_on_state_change(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(0.6)
            changed = monitor.update(DROPPED_PRESSURE)
        assert changed is True
        mock_safety.process_grip_signal.assert_called_with(SafetyState.WARNING)

    def test_does_not_call_when_state_unchanged(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            mock_safety.reset_mock()
            changed = monitor.update(BASELINE_PRESSURE)
        assert changed is False
        mock_safety.process_grip_signal.assert_not_called()

    def test_renews_signal_during_sustained_alarm(self):
        """Regressao: sem isso, o watchdog do SafetyManager (15s sem sinal)
        desligaria sozinho um alarme de garra sustentado -- exatamente o
        corte automatico que o GripMonitor foi desenhado para NAO
        reproduzir (ver docstring do modulo). O lado da visao ja resolve
        isso com HEARTBEAT a cada 3s durante ALARM; a garra precisa do
        mesmo tipo de renovacao."""
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(1.1)
            monitor.update(DROPPED_PRESSURE)  # transiciona para ALARM
            mock_safety.reset_mock()

            # Estado nao muda mais (continua ALARM), mas o sinal deve ser
            # renovado a cada leitura para manter o watchdog vivo.
            clock.advance(5.0)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(5.0)
            monitor.update(DROPPED_PRESSURE)

        assert mock_safety.process_grip_signal.call_count == 2
        mock_safety.process_grip_signal.assert_called_with(SafetyState.ALARM)

    def test_does_not_spam_signal_while_steady_normal(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            mock_safety.reset_mock()
            monitor.update(BASELINE_PRESSURE)
            monitor.update(BASELINE_PRESSURE)
        mock_safety.process_grip_signal.assert_not_called()


class TestReset:
    def test_reset_clears_calibration(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            assert monitor.status()["calibrated"] is True
            monitor.reset()
        status = monitor.status()
        assert status["calibrated"] is False
        assert status["baseline"] is None
        assert status["gripped"] is True
        assert status["state"] == SafetyState.NORMAL

    def test_reset_after_disconnect_does_not_evaluate_against_stale_baseline(self):
        """Regressao: sem reset, uma baseline de antes de uma queda de
        conexao (ou de um Arduino/sensor diferente) seria avaliada
        imediatamente contra a primeira leitura pos-reconexao, pulando a
        fase de calibracao e podendo gerar alarme falso."""
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager"):
            calibrate(monitor, clock)
            monitor.reset()
            # Primeira leitura pos-reset: mesmo que "baixa", nao deve
            # avaliar nada -- ainda esta recalibrando.
            changed = monitor.update(DROPPED_PRESSURE)
        assert changed is False
        assert monitor.status()["calibrated"] is False

    def test_reset_notifies_safety_manager_when_was_active(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            monitor.update(DROPPED_PRESSURE)
            clock.advance(1.1)
            monitor.update(DROPPED_PRESSURE)  # ALARM
            mock_safety.reset_mock()
            monitor.reset()
        mock_safety.process_grip_signal.assert_called_once_with(SafetyState.NORMAL)

    def test_reset_when_already_normal_does_not_notify(self):
        clock = FakeClock()
        monitor = GripMonitor(clock=clock)
        with patch("app.safety.grip_monitor.safety_manager") as mock_safety:
            calibrate(monitor, clock)
            mock_safety.reset_mock()
            monitor.reset()
        mock_safety.process_grip_signal.assert_not_called()
