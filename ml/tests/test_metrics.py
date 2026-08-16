import math

from features.metrics import (
    FeatureExtractor,
    compute_frame_features,
    linear_trend,
    mean,
    stddev,
)

from features.schema import FEATURE_ORDER, NUM_FEATURES


def make_landmarks(ear_scale: float = 1.0):
    """Gera landmarks sintéticos com EAR proporcional ao ear_scale."""
    # Eye vertical distances controlam o EAR. Simples aproximação:
    # landmarks em grid, olhos na região superior.
    lm = [(0.0, 0.0, 0.0)] * 478
    # Preenche pontos de referência
    lm[33] = (0.35, 0.35, 0.0)   # olho esquerdo outer
    lm[133] = (0.45, 0.35, 0.0)  # olho esquerdo inner
    lm[159] = (0.40, 0.33, 0.0)  # top 1
    lm[158] = (0.40, 0.33, 0.0)
    lm[157] = (0.40, 0.33, 0.0)
    lm[173] = (0.40, 0.33, 0.0)
    lm[145] = (0.40, 0.35 + 0.02 * ear_scale, 0.0)  # bottom 1
    lm[153] = (0.40, 0.35 + 0.02 * ear_scale, 0.0)
    lm[154] = (0.40, 0.35 + 0.02 * ear_scale, 0.0)
    lm[155] = (0.40, 0.35 + 0.02 * ear_scale, 0.0)

    lm[362] = (0.55, 0.35, 0.0)  # olho direito outer
    lm[263] = (0.65, 0.35, 0.0)  # olho direito inner
    lm[386] = (0.60, 0.33, 0.0)
    lm[385] = (0.60, 0.33, 0.0)
    lm[384] = (0.60, 0.33, 0.0)
    lm[398] = (0.60, 0.33, 0.0)
    lm[374] = (0.60, 0.35 + 0.02 * ear_scale, 0.0)
    lm[380] = (0.60, 0.35 + 0.02 * ear_scale, 0.0)
    lm[381] = (0.60, 0.35 + 0.02 * ear_scale, 0.0)
    lm[382] = (0.60, 0.35 + 0.02 * ear_scale, 0.0)

    # Boca
    lm[13] = (0.50, 0.55, 0.0)
    lm[14] = (0.50, 0.56, 0.0)
    lm[61] = (0.46, 0.555, 0.0)
    lm[291] = (0.54, 0.555, 0.0)

    # Nariz
    lm[1] = (0.50, 0.50, 0.0)
    lm[168] = (0.50, 0.42, 0.0)

    return lm


def test_feature_order_len():
    assert NUM_FEATURES == 18
    assert len(set(FEATURE_ORDER)) == NUM_FEATURES


def test_compute_frame_features():
    lm_open = make_landmarks(ear_scale=1.0)
    f_open = compute_frame_features(lm_open)

    lm_closed = make_landmarks(ear_scale=0.1)
    f_closed = compute_frame_features(lm_closed)

    assert f_open['ear'] > f_closed['ear']
    assert f_open['ear'] > 0
    assert set(['ear', 'earL', 'earR', 'mouthAspect', 'noseDropRatio', 'yawRatio']).issubset(f_open)


def test_extractor_warmup():
    fe = FeatureExtractor(min_frames=3)
    f = compute_frame_features(make_landmarks(1.0))
    assert fe.extract(f, 0, 0.0, 0.0, None) is None
    assert fe.extract(f, 100, 0.0, 0.0, None) is None
    fv = fe.extract(f, 200, 0.0, 0.0, None)
    assert fv is not None
    assert set(FEATURE_ORDER).issubset(fv)


def test_extractor_gap_reset():
    fe = FeatureExtractor(min_frames=3, max_gap_ms=1000)
    f = compute_frame_features(make_landmarks(1.0))
    fe.extract(f, 0, 0.0, 0.0, None)
    fe.extract(f, 100, 0.0, 0.0, None)
    fe.extract(f, 200, 0.0, 0.0, None)
    assert fe.extract(f, 5000, 0.0, 0.0, None) is None


def test_extractor_trend():
    fe = FeatureExtractor(min_frames=3)
    base = compute_frame_features(make_landmarks(1.0))
    for i, scale in enumerate([1.0, 0.7, 0.4, 0.2]):
        f = compute_frame_features(make_landmarks(scale))
        fv = fe.extract(f, i * 100, 0.0, 0.0, None)
    assert fv is not None
    assert fv['earTrendPerSec'] < 0


def test_mean_stddev():
    assert mean([]) == 0
    assert mean([2, 4, 6]) == 4
    assert stddev([3, 3, 3]) == 0
    assert abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.0) < 1e-5


def test_linear_trend():
    pts = [(0, 0.1), (100, 0.2), (200, 0.3), (300, 0.4)]
    assert linear_trend(pts) > 0
    pts2 = [(0, 0.4), (100, 0.3), (200, 0.2), (300, 0.1)]
    assert linear_trend(pts2) < 0
    assert linear_trend([(0, 1)]) == 0
