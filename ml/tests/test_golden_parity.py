import json
from pathlib import Path

import pytest

from features import FeatureExtractor, analyze_frame
from make_golden_fixture import blink_fixture, build_points, full_landmarks

GOLDEN = json.loads((Path(__file__).resolve().parents[2] / "shared" / "feature_golden.json").read_text(encoding="utf-8"))


def test_fixture_matches_current_python_implementation():
    """O JSON versionado não pode ficar velho em relação ao código Python (senão o teste TS prova nada)."""
    fe = FeatureExtractor()
    for f in GOLDEN["frames"]:
        pts = {int(k): tuple(v) for k, v in f["points"].items()}
        a = analyze_frame(full_landmarks(pts))
        assert a == pytest.approx(f["expectedAnalysis"], rel=1e-12)
        feats = fe.extract(a, f["t"], f["context"]["perclos"], f["context"]["blinkRate"], f["context"]["lastBlinkAt"])
        if f["expectedFeatures"] is None:
            assert feats is None
        else:
            assert feats == pytest.approx(f["expectedFeatures"], rel=1e-12)
    assert blink_fixture() == GOLDEN["blinkSequence"] | {"expected": blink_fixture()["expected"]}
    assert blink_fixture()["expected"] == pytest.approx(GOLDEN["blinkSequence"]["expected"])
