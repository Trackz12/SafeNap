import math

import pytest

from features import FeatureExtractor, analyze_frame, combine_eyes
from features.metrics import LEFT_EYE, dist3d, linear_trend, mean, stddev
from features.schema import FEATURE_ORDER, NUM_FEATURES
from make_golden_fixture import build_points, full_landmarks


def face(openness=1.0, mouth=0.03, yaw=0.0, drop=0.0):
    return full_landmarks(build_points(openness, mouth, yaw, drop))


def test_feature_order_len():
    assert NUM_FEATURES == 18
    assert len(set(FEATURE_ORDER)) == NUM_FEATURES


def test_analyze_frame_open_vs_closed_and_keys():
    open_, closed = analyze_frame(face(1.0)), analyze_frame(face(0.1))
    assert open_["ear"] > closed["ear"] > 0
    assert set(open_) == {"ear", "earL", "earR", "mouthAspect", "noseDropRatio", "yawRatio"}


def test_ear_scale_matches_frontend_formula_mean_of_four_over_h():
    """Regressão do desvio 2x: EAR = média dos 4 pares / largura horizontal (não soma / 2h)."""
    lm = face(1.0)
    h = dist3d(lm[33], lm[133])
    v = [dist3d(lm[u], lm[lo]) for u, lo in LEFT_EYE["verticals"]]
    assert analyze_frame(lm)["earL"] == pytest.approx(sum(v) / (4 * h), rel=1e-12)


@pytest.mark.parametrize("bad", [None, [], [(0.5, 0.5, 0.0)] * 299])
def test_insufficient_landmarks_returns_none(bad):
    assert analyze_frame(bad) is None


def test_face_too_small_or_at_edge_returns_none():
    lm = face()
    lm[263] = (lm[33][0] + 0.05, lm[33][1], 0.0)  # largura < MIN_FACE_WIDTH
    assert analyze_frame(lm) is None
    lm = face()
    lm[152] = (0.5, 0.995, 0.0)  # queixo na borda
    assert analyze_frame(lm) is None


def test_nan_landmark_does_not_produce_features():
    lm = face()
    lm[159] = (float("nan"), 0.4, 0.0)
    assert analyze_frame(lm) is None


def test_combine_eyes_disagreement_and_profile():
    assert combine_eyes(0.3, 0.3) == pytest.approx(0.3)
    assert combine_eyes(0.1, 0.35) == pytest.approx(0.35)  # frontal, discordância -> olho aberto
    assert combine_eyes(0.1, 0.35, yaw_ratio=0.9) == pytest.approx(0.35)  # perfil pleno -> olho visível


def test_extractor_warmup_gap_and_trend():
    fe = FeatureExtractor(min_frames=3, max_gap_ms=1000)
    f = analyze_frame(face())
    assert fe.extract(f, 0, 0.0, 0.0, None) is None
    assert fe.extract(f, 100, 0.0, 0.0, None) is None
    fv = fe.extract(f, 200, 0.0, 0.0, None)
    assert fv is not None and set(fv) == set(FEATURE_ORDER)
    assert fv["msSinceLastBlink"] == -1  # sentinela
    assert fe.extract(f, 5000, 0.0, 0.0, None) is None  # gap > 1 s reinicia a janela

    fe.reset()
    out = None
    for i, o in enumerate([1.0, 0.7, 0.4, 0.2]):
        out = fe.extract(analyze_frame(face(o)), i * 100, 0.0, 0.0, None)
    assert out["earTrendPerSec"] < 0


def test_extractor_ignores_non_monotonic_timestamps():
    fe = FeatureExtractor()
    f = analyze_frame(face())
    for t in (0, 100, 200):
        fe.extract(f, t, 0, 0, None)
    n = len(fe.buffer)
    fe.extract(f, 150, 0, 0, None)
    assert len(fe.buffer) == n


def test_mean_stddev_trend():
    assert mean([]) == 0 and mean([2, 4, 6]) == 4
    assert stddev([3, 3, 3]) == 0
    assert stddev([2, 4, 4, 4, 5, 5, 7, 9]) == pytest.approx(2.0)
    assert linear_trend([(0, 0.1), (100, 0.2), (200, 0.3)]) == pytest.approx(1.0)  # +1 por segundo
    assert linear_trend([(0, 1)]) == 0
    assert math.isfinite(linear_trend([(5, 1), (5, 2)]))
