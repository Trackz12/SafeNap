"""Estado de piscada/PERCLOS — espelho da máquina de estados do DetectionEngine.

O vetor de 18 features do ONNX inclui `perclos`, `blinkRate` e
`msSinceLastBlink`, que NO FRONTEND vêm do DetectionEngine (janela de 60 s,
limiar de EAR calibrado por pessoa). O extrator offline antigo os aproximava
com `perclos = 1.0 if ear < 0.15` e `blinkRate = 0`, o que criava um desvio
treino/inferência. Esta classe reproduz a mesma lógica (preset 'standard'),
verificada por shared/feature_golden.json contra o DetectionEngine real.

Diferença inevitável e documentada: offline não há calibração por pessoa, então
o limiar de EAR é um parâmetro (`threshold`), não a mediana aberto/fechado do
usuário.
"""

import math
from typing import List, Optional, Tuple

# Preset 'standard' de detectionEngine.ts
#
# ATUALIZADO na auditoria de qualidade de detecção (2026-09-23): o frontend
# trocou a confirmação de fechamento de CONTAGEM DE QUADROS por DURAÇÃO (ms)
# com piso de quadros, e o PERCLOS passou a usar tempo de observação válida no
# denominador. Este espelho acompanha — se não acompanhasse, `perclos`,
# `blinkRate` e `msSinceLastBlink` do vetor de features teriam semântica
# diferente no treino (Python) e na inferência (navegador), que é exatamente o
# desvio treino↔inferência que esta classe existe para evitar.
# Ver frontend/src/detection/eye/{eyeStateDetector,perclosTracker}.ts.
CLOSE_CONFIRM_MS = 90
CLOSE_CONFIRM_MIN_FRAMES = 2
HYSTERESIS_FACTOR = 1.15
MIN_BLINK_MS = 50
MAX_BLINK_MS = 400
PERCLOS_WINDOW_MS = 60_000
PERCLOS_IGNORE_MS = 400
PERCLOS_MIN_OBSERVATION_MS = 20_000
BLINK_RATE_WINDOW_MS = 60_000
EAR_SMOOTHING_WINDOW = 3  # mediana de 3 frames aplicada ao EAR


def _median(values: List[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def _js_round(x: float) -> int:
    """Math.round do JavaScript (metade para cima), não o arredondamento bancário do Python."""
    return int(math.floor(x + 0.5))


class BlinkTracker:
    def __init__(self, threshold: float):
        self.threshold = threshold
        self.reset()

    def reset(self) -> None:
        self._ear_buffer: List[float] = []
        self._below_streak = 0
        self._candidate_since: Optional[float] = None
        self._eyes_closed = False
        self._closed_since: Optional[float] = None
        self._segments: List[Tuple[float, float]] = []
        self._lost_intervals: List[Tuple[float, float]] = []
        self._lost_since: Optional[float] = None
        self._blinks: List[float] = []
        self._started_at: Optional[float] = None

    def face_lost(self, t_ms: float) -> None:
        """Equivalente ao tratamento de processNoFace(): fecha o segmento aberto e limpa o candidato."""
        if self._started_at is None:
            self._started_at = t_ms
        if self._lost_since is None:
            self._lost_since = t_ms
        if self._eyes_closed and self._closed_since is not None:
            self._segments.append((self._closed_since, t_ms))
        self._eyes_closed = False
        self._closed_since = None
        self._below_streak = 0
        self._candidate_since = None
        self._ear_buffer = []

    def update(self, raw_ear: float, t_ms: float) -> None:
        if self._started_at is None:
            self._started_at = t_ms
        if self._lost_since is not None:
            self._lost_intervals.append((self._lost_since, t_ms))
            self._lost_since = None

        self._ear_buffer.append(raw_ear)
        if len(self._ear_buffer) > EAR_SMOOTHING_WINDOW:
            self._ear_buffer.pop(0)
        ear = _median(self._ear_buffer)

        if ear < self.threshold:
            if self._candidate_since is None:
                self._candidate_since = t_ms
            self._below_streak += 1
        else:
            self._below_streak = 0
            self._candidate_since = None

        below_for_ms = t_ms - self._candidate_since if self._candidate_since is not None else 0.0
        confirmed = (below_for_ms >= CLOSE_CONFIRM_MS
                     and self._below_streak >= CLOSE_CONFIRM_MIN_FRAMES)

        closed = self._eyes_closed
        if not self._eyes_closed and confirmed:
            closed = True
        elif self._eyes_closed and ear > self.threshold * HYSTERESIS_FACTOR:
            closed = False

        if closed and not self._eyes_closed:
            self._eyes_closed = True
            self._closed_since = self._candidate_since if self._candidate_since is not None else t_ms
        elif not closed and self._eyes_closed:
            start = self._closed_since if self._closed_since is not None else t_ms
            duration = t_ms - start
            self._segments.append((start, t_ms))
            self._eyes_closed = False
            self._closed_since = None
            self._below_streak = 0
            self._candidate_since = None
            if MIN_BLINK_MS <= duration <= MAX_BLINK_MS:
                self._blinks.append(t_ms)

    def valid_observed_ms(self, t_ms: float) -> float:
        """Denominador real: janela limitada pelo início da observação, menos tempo sem rosto."""
        window_start = t_ms - PERCLOS_WINDOW_MS
        self._lost_intervals = [iv for iv in self._lost_intervals if iv[1] > window_start]
        lost_ms = sum(e - max(s, window_start) for s, e in self._lost_intervals)
        if self._lost_since is not None:
            lost_ms += t_ms - max(self._lost_since, window_start)
        elapsed = 0.0 if self._started_at is None else min(
            float(PERCLOS_WINDOW_MS), t_ms - self._started_at
        )
        return max(0.0, elapsed - lost_ms)

    def perclos(self, t_ms: float) -> float:
        window_start = t_ms - PERCLOS_WINDOW_MS
        self._segments = [s for s in self._segments
                          if s[1] > window_start and s[1] - s[0] >= PERCLOS_IGNORE_MS]
        closed_ms = sum(e - max(s, window_start) for s, e in self._segments)
        if self._eyes_closed and self._closed_since is not None:
            closed_ms += t_ms - max(self._closed_since, window_start)
        valid = self.valid_observed_ms(t_ms)
        return min(1.0, closed_ms / valid) if valid > 0 else 0.0

    def perclos_sufficient(self, t_ms: float) -> bool:
        """Espelha PerclosResult.sufficient — se a razão tem observação suficiente pra valer."""
        return self.valid_observed_ms(t_ms) >= PERCLOS_MIN_OBSERVATION_MS

    def blink_rate(self, t_ms: float) -> int:
        window_start = t_ms - BLINK_RATE_WINDOW_MS
        self._blinks = [b for b in self._blinks if b > window_start]
        if self._started_at is None:
            return 0
        elapsed = min(float(BLINK_RATE_WINDOW_MS), max(1.0, t_ms - self._started_at))
        observed = max(1.0, min(elapsed, self.valid_observed_ms(t_ms)))
        return _js_round(len(self._blinks) / (observed / BLINK_RATE_WINDOW_MS))

    @property
    def last_blink_at(self) -> Optional[float]:
        return self._blinks[-1] if self._blinks else None
