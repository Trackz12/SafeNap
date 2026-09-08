"""Monitor do sensor de pressao FSR-402 (empunhadura do volante).

Hardware real: UM sensor FSR-402 no pino A0 do Arduino — confirmado pelo
firmware historico (`fsrPin = A0`) que rodou nas simulacoes originais do
TCC, nao dois sensores como uma versao anterior deste modulo assumia.

Segue o mesmo principio do resto do hardware: o Arduino so manda o
numero cru (`FSR:<valor>`), toda a interpretacao (calibracao de
baseline, limiar de queda, debounce) mora aqui no backend. O resultado
alimenta o SafetyManager como uma SEGUNDA fonte de sinal, fundida em OR
com os eventos de visao/ML que vem do frontend (ver
SafetyManager._vision_state / _grip_state) — a queda de pressao pode
disparar alerta mesmo que a camera nao tenha detectado nada, e vice-versa.

Isso e uma modernizacao deliberada do firmware historico, que fazia essa
mesma fusao (Python + FSR) dentro do proprio Arduino, com limiar fixo
(`fsrLimite = 220`) e um corte automatico do alarme apos 10s
(`tempoMaximoAlerta`) independente de a mao ter voltado ao volante. Este
modulo NAO reproduz o corte automatico: sonolencia real nao tem prazo de
validade, e desligar um alarme de seguranca sozinho — sem confirmacao do
usuario — seria um regresso de seguranca. A tolerancia de queda sustentada
antes do alarme (1s) e a mesma usada no firmware historico
(`tempoTolerancia`), agora com um estagio adicional de aviso mais cedo
(500ms) que o sistema original nao tinha.

Calibracao: a baseline e uma media movel exponencial (EMA) que so anda
enquanto a mao esta detectada no volante ("gripped"); ela congela assim
que a queda e detectada, para nao "absorver" a propria queda como novo
normal — uma melhoria sobre o limiar fixo do firmware historico, que
exigia recalibrar manualmente o `fsrLimite` para cada sensor/instalacao.
Histerese: perder a garra exige pressao abaixo de DROP_RATIO x baseline;
recuperar exige pressao acima de RECOVER_RATIO x baseline (RECOVER_RATIO
> DROP_RATIO), mesmo padrao ja usado no threshold do EAR no frontend.
"""

import logging
import time
from typing import Callable

from app.core.protocol import SafetyState
from app.safety.manager import safety_manager

logger = logging.getLogger(__name__)


class GripMonitor:
    # Fracao de adaptacao da baseline por amostra, uma vez calibrada.
    BASELINE_ALPHA = 0.05

    # Amostras minimas (a ~200ms cada = ~3s) antes de avaliar quedas.
    MIN_BASELINE_SAMPLES = 15

    # Histerese: perde a garra abaixo disso, so recupera acima do outro.
    DROP_RATIO = 0.35
    RECOVER_RATIO = 0.60

    # Debounce temporal (queda sustentada). ALARM_MS replica a tolerancia
    # de 1s do firmware historico (`tempoTolerancia`); WARNING_MS e um
    # estagio de aviso adicional que o sistema original nao tinha.
    WARNING_MS = 500.0
    ALARM_MS = 1000.0

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._baseline: float | None = None
        self._sample_count = 0
        self._gripped = True
        self._lost_since: float | None = None
        self._state: SafetyState = SafetyState.NORMAL
        self._last_pressure = 0.0

    def update(self, pressure: float) -> bool:
        """Processa uma nova leitura do sensor FSR (pino A0).

        Retorna True quando o estado do grip mudou (o chamador decide se
        emite um broadcast `GRIP_STATUS`)."""
        self._last_pressure = pressure
        now = self._clock()

        if self._baseline is None:
            self._baseline = pressure
            self._sample_count = 1
            return False

        if self._sample_count < self.MIN_BASELINE_SAMPLES:
            self._sample_count += 1
            self._baseline += (pressure - self._baseline) / self._sample_count
            return False

        drop_threshold = self._baseline * self.DROP_RATIO
        recover_threshold = self._baseline * self.RECOVER_RATIO

        if self._gripped and pressure < drop_threshold:
            self._gripped = False
            self._lost_since = now
            logger.info("Grip: queda de pressao detectada (pressao=%.1f, baseline=%.1f)", pressure, self._baseline)
        elif not self._gripped and pressure > recover_threshold:
            self._gripped = True
            self._lost_since = None
            logger.info("Grip: pressao restabelecida (pressao=%.1f, baseline=%.1f)", pressure, self._baseline)

        # Baseline so acompanha a pressao enquanto a garra esta OK --
        # congelada durante a queda para nao mascarar o proprio evento.
        if self._gripped:
            self._baseline += (pressure - self._baseline) * self.BASELINE_ALPHA

        previous_state = self._state
        self._state = self._evaluate_state(now)

        changed = self._state != previous_state
        if changed:
            safety_manager.process_grip_signal(self._state)
        return changed

    def _evaluate_state(self, now: float) -> SafetyState:
        if self._gripped:
            return SafetyState.NORMAL
        # Sem corte automatico: enquanto a queda persistir, o estado
        # permanece ALARM indefinidamente (ver docstring do modulo).
        lost_for_s = now - (self._lost_since or now)
        if lost_for_s >= self.ALARM_MS / 1000.0:
            return SafetyState.ALARM
        if lost_for_s >= self.WARNING_MS / 1000.0:
            return SafetyState.WARNING
        return SafetyState.NORMAL

    def status(self) -> dict:
        """Snapshot para o endpoint /api/status e o broadcast GRIP_STATUS."""
        return {
            "pressure": self._last_pressure,
            "baseline": self._baseline,
            "gripped": self._gripped,
            "state": self._state,
            "calibrated": self._sample_count >= self.MIN_BASELINE_SAMPLES,
        }


grip_monitor = GripMonitor()
