import math
from typing import Dict, List, Optional, Sequence, Tuple

from .schema import NULL_BLINK_SENTINEL


# ── Tipos ──

Point = Tuple[float, float, Optional[float]]


# ── Geometria ──

def dist3d(a: Point, b: Point) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = (a[2] or 0.0) - (b[2] or 0.0)
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def dist2d(a: Point, b: Point) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return math.sqrt(dx * dx + dy * dy)


# Índices de landmarks MediaPipe FaceMesh (compatíveis com o frontend)
LEFT_EYE = {
    'outer': 33, 'inner': 133,
    'top': [159, 158, 157, 173],
    'bottom': [145, 153, 154, 155],
}
RIGHT_EYE = {
    'outer': 362, 'inner': 263,
    'top': [386, 385, 384, 398],
    'bottom': [374, 380, 381, 382],
}

MOUTH_TOP = 13
MOUTH_BOTTOM = 14
MOUTH_LEFT = 61
MOUTH_RIGHT = 291

NOSE_TIP = 1
NOSE_BRIDGE = 168

LEFT_EYE_OUTER = 33
RIGHT_EYE_OUTER = 263


def _eye_ear(landmarks: Sequence[Point], eye: Dict[str, object]) -> float:
    outer = landmarks[eye['outer']]
    inner = landmarks[eye['inner']]
    h = eye['horizontal'](outer, inner)
    if h <= 1e-9:
        return 0.0
    v1 = dist3d(landmarks[eye['top'][0]], landmarks[eye['bottom'][0]])
    v2 = dist3d(landmarks[eye['top'][1]], landmarks[eye['bottom'][1]])
    v3 = dist3d(landmarks[eye['top'][2]], landmarks[eye['bottom'][2]])
    v4 = dist3d(landmarks[eye['top'][3]], landmarks[eye['bottom'][3]])
    return (v1 + v2 + v3 + v4) / (2.0 * h)


# Preencher função horizontal conforme o tipo de eye
LEFT_EYE['horizontal'] = lambda o, i: dist3d(o, i)
RIGHT_EYE['horizontal'] = lambda o, i: dist3d(o, i)


def compute_frame_features(landmarks: Sequence[Point]) -> Dict[str, float]:
    """Computa as 6 features brutas de um frame (mesma lógica do frontend)."""
    ear_l = _eye_ear(landmarks, LEFT_EYE)
    ear_r = _eye_ear(landmarks, RIGHT_EYE)

    # EAR combinado (média, com fallback anti-reflexo de óculos)
    if abs(ear_l - ear_r) > 0.55 * max(ear_l, ear_r):
        ear = max(ear_l, ear_r)
    else:
        ear = (ear_l + ear_r) / 2.0

    # Mouth aspect ratio
    mouth_w = dist2d(landmarks[MOUTH_LEFT], landmarks[MOUTH_RIGHT])
    mouth_h = dist2d(landmarks[MOUTH_TOP], landmarks[MOUTH_BOTTOM])
    mouth_aspect = mouth_h / mouth_w if mouth_w > 1e-9 else 0.0

    # Nose drop ratio (queda do nariz vs eixo dos olhos, normalizada pela altura do rosto)
    eye_line_len = dist2d(landmarks[LEFT_EYE_OUTER], landmarks[RIGHT_EYE_OUTER])
    face_height = dist2d(landmarks[NOSE_BRIDGE], landmarks[NOSE_TIP])
    nose_drop = face_height / eye_line_len if eye_line_len > 1e-9 else 0.0

    # Yaw ratio (deslocamento horizontal do nariz vs centro dos olhos)
    eye_mid_x = (landmarks[LEFT_EYE_OUTER][0] + landmarks[RIGHT_EYE_OUTER][0]) / 2.0
    nose_x = landmarks[NOSE_TIP][0]
    yaw = (nose_x - eye_mid_x) / eye_line_len if eye_line_len > 1e-9 else 0.0

    return {
        'ear': ear,
        'earL': ear_l,
        'earR': ear_r,
        'mouthAspect': mouth_aspect,
        'noseDropRatio': nose_drop,
        'yawRatio': yaw,
    }


# ── Janela deslizante (espelha featureExtractor.ts) ──

def mean(values: List[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stddev(values: List[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / n)


def linear_trend(points: List[Tuple[int, float]]) -> float:
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
    """Espelha o FeatureExtractor do frontend (bufferSize=10, minFrames=3, gap=1000ms)."""

    def __init__(self, buffer_size: int = 10, min_frames: int = 3, max_gap_ms: int = 1000):
        self.buffer_size = buffer_size
        self.min_frames = min_frames
        self.max_gap_ms = max_gap_ms
        self.buffer: List[Tuple[int, Dict[str, float]]] = []

    def reset(self) -> None:
        self.buffer.clear()

    def _push(self, features: Dict[str, float], t_ms: int) -> bool:
        if not all(math.isfinite(v) for v in features.values()):
            return False
        if self.buffer and t_ms <= self.buffer[-1][0]:
            return False
        if self.buffer and (t_ms - self.buffer[-1][0]) > self.max_gap_ms:
            self.buffer.clear()
        self.buffer.append((t_ms, features))
        if len(self.buffer) > self.buffer_size:
            self.buffer.pop(0)
        return True

    def extract(self, frame_features: Dict[str, float], t_ms: int,
                perclos: float, blink_rate: float, last_blink_at: Optional[int]) -> Optional[Dict[str, float]]:
        if not self._push(frame_features, t_ms):
            return None
        if len(self.buffer) < self.min_frames:
            return None

        ears = [f['ear'] for _, f in self.buffer]
        mouths = [f['mouthAspect'] for _, f in self.buffer]
        nose_drops = [f['noseDropRatio'] for _, f in self.buffer]
        ear_pts = [(t, f['ear']) for t, f in self.buffer]
        mouth_pts = [(t, f['mouthAspect']) for t, f in self.buffer]

        last = frame_features
        ms_blink = NULL_BLINK_SENTINEL if last_blink_at is None else max(0, t_ms - last_blink_at)

        return {
            'ear': last['ear'],
            'earL': last['earL'],
            'earR': last['earR'],
            'mouthAspect': last['mouthAspect'],
            'noseDropRatio': last['noseDropRatio'],
            'yawRatio': last['yawRatio'],
            'earMean': mean(ears),
            'earStdDev': stddev(ears),
            'earMin': min(ears),
            'earMax': max(ears),
            'earTrendPerSec': linear_trend(ear_pts),
            'blinkRate': blink_rate,
            'msSinceLastBlink': ms_blink,
            'perclos': perclos,
            'mouthMean': mean(mouths),
            'mouthMax': max(mouths),
            'mouthTrendPerSec': linear_trend(mouth_pts),
            'noseDropMean': mean(nose_drops),
        }


def vector_to_list(fv: Dict[str, float]) -> List[float]:
    from .schema import FEATURE_ORDER
    return [fv[k] for k in FEATURE_ORDER]
