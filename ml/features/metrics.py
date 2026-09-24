"""Geometria facial e janela deslizante — espelho do frontend.

Fonte de verdade do comportamento: frontend/src/vision/frameAnalyzer.ts e
frontend/src/detection/featureExtractor.ts. A paridade é verificada por
shared/feature_golden.json (ml/tests/test_golden_parity.py e
frontend/src/ml/goldenParity.test.ts).

Quirk herdado do TypeScript e mantido de propósito: `dist(midEyes, chin)` usa
z=0 para o ponto médio dos olhos (que não tem z), então a "altura do rosto"
inclui chin.z². Corrigir só de um lado quebraria a paridade.
"""

import math
from typing import Dict, List, Optional, Sequence, Tuple

from .schema import LANDMARKS, NULL_BLINK_SENTINEL, WINDOW

Point = Tuple[float, float, Optional[float]]

# ── Constantes espelhadas de frameAnalyzer.ts ──
MIN_FACE_WIDTH = 0.10
EDGE_MARGIN = 0.01
EYE_DISAGREEMENT_RATIO = 0.55
YAW_PROFILE_THRESHOLD = 0.25
YAW_TRANSITION_RANGE = 0.35
MIN_LANDMARKS = 300

LEFT_EYE = LANDMARKS["leftEye"]
RIGHT_EYE = LANDMARKS["rightEye"]
EYE_OUTER_LEFT = LANDMARKS["eyeOuterLeft"]
EYE_OUTER_RIGHT = LANDMARKS["eyeOuterRight"]
NOSE_TIP = LANDMARKS["noseTip"]
CHIN = LANDMARKS["chin"]
MOUTH = LANDMARKS["mouth"]


def dist3d(a: Point, b: Point) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = (a[2] or 0.0) - (b[2] or 0.0)
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _near_edge(p: Point, margin: float) -> bool:
    return p[0] < margin or p[0] > 1 - margin or p[1] < margin or p[1] > 1 - margin


def eye_ear(landmarks: Sequence[Point], eye: dict) -> float:
    h1, h2 = eye["h"]
    horizontal = dist3d(landmarks[h1], landmarks[h2])
    if horizontal <= 1e-6:
        return 0.0
    total = 0.0
    for up, lo in eye["verticals"]:
        total += dist3d(landmarks[up], landmarks[lo])
    return total / (len(eye["verticals"]) * horizontal)


def combine_eyes(ear_l: float, ear_r: float, yaw_ratio: float = 0.0) -> float:
    lo, hi = min(ear_l, ear_r), max(ear_l, ear_r)
    abs_yaw = abs(yaw_ratio)
    if abs_yaw > YAW_PROFILE_THRESHOLD:
        yaw_factor = min(1.0, (abs_yaw - YAW_PROFILE_THRESHOLD) / YAW_TRANSITION_RANGE)
        front = (ear_l + ear_r) / 2
        return front * (1 - yaw_factor) + hi * yaw_factor
    if hi > 1e-6 and lo / hi < EYE_DISAGREEMENT_RATIO:
        return hi
    return (ear_l + ear_r) / 2


def analyze_frame(landmarks: Optional[Sequence[Point]]) -> Optional[Dict[str, float]]:
    """Equivalente Python de analyzeFrame(): 6 valores brutos ou None (rosto inválido)."""
    if landmarks is None or len(landmarks) < MIN_LANDMARKS:
        return None

    left_outer = landmarks[EYE_OUTER_LEFT]
    right_outer = landmarks[EYE_OUTER_RIGHT]
    nose = landmarks[NOSE_TIP]
    chin = landmarks[CHIN]

    face_width = dist3d(left_outer, right_outer)
    if face_width < MIN_FACE_WIDTH:
        return None
    if _near_edge(nose, EDGE_MARGIN) or _near_edge(chin, EDGE_MARGIN):
        return None

    mid_x = (left_outer[0] + right_outer[0]) / 2
    yaw_estimate = abs(nose[0] - mid_x) / face_width if face_width > 1e-6 else 0.0
    if yaw_estimate < 0.3:
        if any(_near_edge(landmarks[i], EDGE_MARGIN)
               for i in (EYE_OUTER_LEFT, EYE_OUTER_RIGHT, MOUTH["left"], MOUTH["right"])):
            return None

    ear_l = eye_ear(landmarks, LEFT_EYE)
    ear_r = eye_ear(landmarks, RIGHT_EYE)

    mid_y = (left_outer[1] + right_outer[1]) / 2
    face_height = dist3d((mid_x, mid_y, None), chin)  # z do ponto médio = 0 (quirk do TS)
    nose_drop = (nose[1] - mid_y) / face_height if face_height > 1e-6 else 0.0
    yaw_ratio = (nose[0] - mid_x) / face_width if face_width > 1e-6 else 0.0

    ear = combine_eyes(ear_l, ear_r, yaw_ratio)

    mouth_width = dist3d(landmarks[MOUTH["left"]], landmarks[MOUTH["right"]])
    mouth_aspect = (dist3d(landmarks[MOUTH["top"]], landmarks[MOUTH["bottom"]]) / mouth_width
                    if mouth_width > 1e-6 else 0.0)

    if not (math.isfinite(ear) and math.isfinite(mouth_aspect) and math.isfinite(nose_drop)):
        return None
    return {
        "ear": ear, "earL": ear_l, "earR": ear_r,
        "mouthAspect": mouth_aspect, "noseDropRatio": nose_drop, "yawRatio": yaw_ratio,
    }


# Nome histórico usado por testes/scripts anteriores.
compute_frame_features = analyze_frame


# ── Estatística da janela (espelha featureExtractor.ts) ──

def mean(values: List[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stddev(values: List[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / n)


def linear_trend(points: List[Tuple[float, float]]) -> float:
    """Inclinação por SEGUNDO (t em ms) da regressão linear."""
    n = len(points)
    if n < 2:
        return 0.0
    s_t = sum(p[0] for p in points)
    s_v = sum(p[1] for p in points)
    s_tv = sum(p[0] * p[1] for p in points)
    s_t2 = sum(p[0] * p[0] for p in points)
    denom = n * s_t2 - s_t * s_t
    if abs(denom) < 1e-10:
        return 0.0
    return ((n * s_tv - s_t * s_v) / denom) * 1000.0


class FeatureExtractor:
    """Janela deslizante de frames → 18 features (espelha FeatureExtractor do frontend)."""

    def __init__(self, buffer_size: int = WINDOW["bufferSize"], min_frames: int = WINDOW["minFrames"],
                 max_gap_ms: int = WINDOW["maxGapMs"], window_ms: int = WINDOW["windowMs"]):
        # window_ms governa a janela (fenomeno temporal); buffer_size e teto de
        # memoria. Ver frontend/src/detection/featureExtractor.ts para o racional.
        self.window_ms = window_ms
        self.buffer_size = buffer_size
        self.min_frames = min_frames
        self.max_gap_ms = max_gap_ms
        self.buffer: List[Tuple[float, Dict[str, float]]] = []

    def reset(self) -> None:
        self.buffer = []

    def _push(self, frame: Dict[str, float], t_ms: float) -> None:
        if not math.isfinite(t_ms):
            return
        if not all(math.isfinite(frame[k]) for k in ("ear", "mouthAspect", "noseDropRatio", "yawRatio")):
            return
        if self.buffer and t_ms <= self.buffer[-1][0]:
            return
        if self.buffer and (t_ms - self.buffer[-1][0]) > self.max_gap_ms:
            self.buffer = []
        self.buffer.append((t_ms, frame))
        cutoff = t_ms - self.window_ms
        while self.buffer and self.buffer[0][0] < cutoff:
            self.buffer.pop(0)
        while len(self.buffer) > self.buffer_size:
            self.buffer.pop(0)

    def extract(self, frame: Dict[str, float], t_ms: float, perclos: float, blink_rate: float,
                last_blink_at: Optional[float]) -> Optional[Dict[str, float]]:
        self._push(frame, t_ms)  # como no TS: push rejeitado não impede a extração
        if len(self.buffer) < self.min_frames:
            return None

        ears = [f["ear"] for _, f in self.buffer]
        mouths = [f["mouthAspect"] for _, f in self.buffer]
        noses = [f["noseDropRatio"] for _, f in self.buffer]
        return {
            "ear": frame["ear"], "earL": frame["earL"], "earR": frame["earR"],
            "mouthAspect": frame["mouthAspect"], "noseDropRatio": frame["noseDropRatio"],
            "yawRatio": frame["yawRatio"],
            "earMean": mean(ears), "earStdDev": stddev(ears),
            "earMin": min(ears), "earMax": max(ears),
            "earTrendPerSec": linear_trend([(t, f["ear"]) for t, f in self.buffer]),
            "blinkRate": blink_rate,
            "msSinceLastBlink": (NULL_BLINK_SENTINEL if last_blink_at is None
                                 else max(0.0, t_ms - last_blink_at)),
            "perclos": perclos,
            "mouthMean": mean(mouths), "mouthMax": max(mouths),
            "mouthTrendPerSec": linear_trend([(t, f["mouthAspect"]) for t, f in self.buffer]),
            "noseDropMean": mean(noses),
        }


def vector_to_list(fv: Dict[str, float]) -> List[float]:
    from .schema import FEATURE_ORDER
    return [fv[k] for k in FEATURE_ORDER]
