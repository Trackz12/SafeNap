"""Contrato do ONNX EMBARCADO (frontend/public/models/drowsiness.onnx) com o que o frontend assume.

Isto verifica FORMA e semântica de I/O, não qualidade de detecção. O modelo
embarcado é EXPERIMENTAL (treinado em dados sintéticos): ver docs/ML_PIPELINE.md.
"""

import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import pytest

from features.schema import FEATURE_ORDER, NUM_FEATURES, SCHEMA_HASH

MODELS = Path(__file__).resolve().parents[2] / "frontend" / "public" / "models"
ONNX_PATH = MODELS / "drowsiness.onnx"
IDX = {n: i for i, n in enumerate(FEATURE_ORDER)}

pytestmark = pytest.mark.skipif(not ONNX_PATH.exists(), reason="modelo embarcado ausente")


@pytest.fixture(scope="module")
def sess():
    return ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])


def test_io_contract_matches_frontend_assumptions(sess):
    (inp,) = sess.get_inputs()
    assert inp.name == "features" and inp.type == "tensor(float)"
    assert inp.shape[1] == NUM_FEATURES == 18
    assert [o.name for o in sess.get_outputs()] == ["label", "probabilities"]


def test_it_is_a_tree_ensemble_classifier_with_classes_0_1():
    g = onnx.load(str(ONNX_PATH)).graph
    nodes = [n for n in g.node if n.op_type == "TreeEnsembleClassifier"]
    assert len(g.node) == 1 and len(nodes) == 1
    attrs = {a.name: a for a in nodes[0].attribute}
    assert list(attrs["classlabels_int64s"].ints) == [0, 1]           # índice 1 = DROWSY
    assert max(attrs["nodes_featureids"].ints) < NUM_FEATURES         # nenhuma árvore usa feature fora do schema


def test_probabilities_are_a_valid_distribution_and_finite(sess):
    rng = np.random.RandomState(0)
    x = rng.uniform(-1, 1, (200, NUM_FEATURES)).astype(np.float32)
    p = sess.run(["probabilities"], {"features": x})[0]
    assert p.shape == (200, 2) and np.isfinite(p).all()
    np.testing.assert_allclose(p.sum(axis=1), 1.0, atol=1e-5)
    assert (p >= 0).all() and (p <= 1).all()


def test_batch_of_one_and_extreme_values_do_not_crash_or_yield_nan(sess):
    for v in (0.0, -1.0, 1e6, -1e6):
        out = sess.run(["probabilities"], {"features": np.full((1, NUM_FEATURES), v, np.float32)})[0]
        assert np.isfinite(out).all()


def test_smoke_model_reacts_to_obviously_extreme_inputs(sess):
    """Fumaça, NÃO acurácia: vetor claramente 'alerta' pontua abaixo de ML_WARNING (0,85); olhos quase fechados e PERCLOS alto, acima."""
    def vec(**kw):
        v = np.zeros((1, NUM_FEATURES), np.float32)
        base = dict(ear=.30, earL=.30, earR=.30, mouthAspect=.08, noseDropRatio=.45, earMean=.30, earStdDev=.01,
                    earMin=.28, earMax=.32, blinkRate=15, msSinceLastBlink=2000, perclos=.02,
                    mouthMean=.08, mouthMax=.10, noseDropMean=.45)
        base.update(kw)
        for k, x in base.items():
            v[0, IDX[k]] = x
        return v

    p = lambda v: float(sess.run(["probabilities"], {"features": v})[0][0][1])  # noqa: E731
    awake = p(vec())
    drowsy = p(vec(ear=.12, earL=.12, earR=.12, earMean=.13, earMin=.10, earMax=.16, perclos=.5,
                   blinkRate=5, msSinceLastBlink=6000))
    assert awake < 0.85 <= drowsy


def test_model_card_matches_the_shipped_file_and_schema():
    card_path = MODELS / "drowsiness.model-card.json"
    assert card_path.exists(), "todo ONNX embarcado precisa de model card (proveniência)"
    card = json.loads(card_path.read_text(encoding="utf-8"))
    import hashlib
    assert card["onnx"]["sha256"] == hashlib.sha256(ONNX_PATH.read_bytes()).hexdigest()
    assert card["schema_hash"] == SCHEMA_HASH and card["features"] == FEATURE_ORDER
    assert card["status"].split()[0] in {"EXPERIMENTAL", "EXPERIMENTAL/SINTÉTICO"}


def test_onnx_golden_fixture_is_in_sync_with_the_shipped_model():
    """shared/onnx_golden.json alimenta o teste do ORT-web (TS); precisa refletir o arquivo embarcado."""
    import hashlib
    fx = json.loads((MODELS.parents[2] / "shared" / "onnx_golden.json").read_text(encoding="utf-8"))
    assert fx["model_sha256"] == hashlib.sha256(ONNX_PATH.read_bytes()).hexdigest(),         "modelo mudou: rode ml/scripts/make_golden_fixture.py"
    s = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    got = s.run(["probabilities"], {"features": np.asarray(fx["vectors"], dtype=np.float32)})[0][:, 1]
    np.testing.assert_allclose(got, fx["expected_p_drowsy"], atol=1e-6)
