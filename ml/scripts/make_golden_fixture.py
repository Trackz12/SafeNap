"""Gera shared/feature_golden.json — fixture de paridade Python ↔ TypeScript.

O Python calcula as saídas esperadas; os testes de AMBOS os lados as reproduzem:
  - ml/tests/test_golden_parity.py (Python, sem regerar)
  - frontend/src/ml/goldenParity.test.ts (analyzeFrame, FeatureExtractor e
    DetectionEngine reais em TypeScript)
Se as duas implementações concordam com o mesmo arquivo, o desvio treino/inferência
de geometria e janela é zero (até a tolerância numérica).

Regerar SÓ quando o schema/geometria mudar de propósito:
    cd ml && .venv/Scripts/python.exe scripts/make_golden_fixture.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from features import BlinkTracker, FeatureExtractor, analyze_frame  # noqa: E402
from features.schema import LANDMARKS  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "shared" / "feature_golden.json"
ONNX_OUT = Path(__file__).resolve().parents[2] / "shared" / "onnx_golden.json"
MODEL_PATH = Path(__file__).resolve().parents[2] / "frontend" / "public" / "models" / "drowsiness.onnx"
N_LANDMARKS = 478
T0 = 1_000_000


def build_points(openness: float, mouth: float, yaw_shift: float, drop: float) -> dict:
    """Rosto sintético determinístico; z ≠ 0 e pares verticais distintos para exercitar 3D e o mapeamento de índices."""
    pts = {}
    pts[33] = (0.35, 0.40, 0.000)
    pts[133] = (0.45, 0.40, 0.004)
    pts[263] = (0.65, 0.40, 0.000)
    pts[362] = (0.55, 0.40, 0.004)
    for eye in (LANDMARKS["leftEye"], LANDMARKS["rightEye"]):
        for k, (up, lo) in enumerate(eye["verticals"]):
            half = openness * (0.012 + 0.004 * k)
            x = 0.30 + up * 0.0004
            pts[up] = (x, 0.40 - half, -0.006 * (k + 1))
            pts[lo] = (x + 0.003, 0.40 + half, 0.004 * (k + 1))
    m = LANDMARKS["mouth"]
    pts[m["top"]] = (0.50, 0.65 - mouth / 2, 0.01)
    pts[m["bottom"]] = (0.50, 0.65 + mouth / 2, 0.012)
    pts[m["left"]] = (0.44, 0.65, 0.02)
    pts[m["right"]] = (0.56, 0.65, 0.021)
    pts[LANDMARKS["noseTip"]] = (0.50 + yaw_shift, 0.52 + drop, -0.03)
    pts[LANDMARKS["chin"]] = (0.50, 0.85, 0.03)  # z ≠ 0 exercita o quirk de faceHeight
    return pts


def full_landmarks(points: dict) -> list:
    lm = [(0.5, 0.5, 0.0)] * N_LANDMARKS
    lm = list(lm)
    for i, p in points.items():
        lm[i] = p
    return lm


def frames_fixture() -> list:
    openness = [1.0, 1.0, 1.0, 0.9, 0.5, 0.15, 0.10, 0.15, 0.6, 1.0, 1.0, 1.0, 0.95, 1.0]
    mouth = [0.03, 0.03, 0.04, 0.05, 0.05, 0.06, 0.06, 0.20, 0.55, 0.60, 0.30, 0.08, 0.04, 0.03]
    yaw = [0.0, 0.01, 0.0, -0.01, 0.0, 0.02, 0.0, 0.0, 0.03, 0.0, -0.02, 0.0, 0.0, 0.01]
    drop = [0.0, 0.0, 0.01, 0.0, 0.02, 0.03, 0.05, 0.06, 0.02, 0.0, 0.0, 0.01, 0.0, 0.0]

    fe = FeatureExtractor()
    out = []
    for i in range(len(openness)):
        t = T0 + i * 100
        pts = build_points(openness[i], mouth[i], yaw[i], drop[i])
        analysis = analyze_frame(full_landmarks(pts))
        assert analysis is not None
        last_blink = None if i < 5 else t - 1300
        ctx = {"perclos": 0.12, "blinkRate": 14, "lastBlinkAt": last_blink}
        feats = fe.extract(analysis, t, ctx["perclos"], ctx["blinkRate"], last_blink)
        out.append({
            "t": t,
            "points": {str(k): list(v) for k, v in sorted(pts.items())},
            "context": ctx,
            "expectedAnalysis": analysis,
            "expectedFeatures": feats,
        })
    return out


def blink_fixture(threshold: float = 0.25) -> dict:
    """400 frames a 10 fps: piscadas de 300 ms, um pico isolado (mediana-3 deve ignorar) e fechamentos longos (1,2 s)."""
    ears = []
    for cycle in range(8):
        block = [0.35] * 50
        block[10:13] = [0.10] * 3           # piscada ~300 ms
        block[20] = 0.10                    # pico isolado de 1 frame (jitter)
        if cycle % 2 == 1:
            block[30:42] = [0.10] * 12      # fechamento longo ~1,2 s
        ears.extend(block)
    start = 2_000_000
    tracker = BlinkTracker(threshold)
    expected = []
    for i, e in enumerate(ears):
        t = start + i * 100
        tracker.update(e, t)
        expected.append({"perclos": tracker.perclos(t), "blinkRate": tracker.blink_rate(t)})
    return {"threshold": threshold, "start": start, "dtMs": 100, "ears": ears, "expected": expected}


def onnx_fixture() -> dict:
    """P(DROWSY) esperada (ORT Python) para vetores fixos, para conferir o ORT-web do navegador.

    Só o índice 1 de `probabilities` é comparável entre runtimes: o ORT-web 1.27 devolve
    [-p, p] e label=1 para este TreeEnsembleClassifier binário, o ORT Python devolve [1-p, p].
    """
    import hashlib
    import numpy as np
    import onnxruntime as ort
    from features.schema import FEATURE_ORDER

    idx = {n: i for i, n in enumerate(FEATURE_ORDER)}
    awake = dict(ear=.30, earL=.30, earR=.30, mouthAspect=.08, noseDropRatio=.45, yawRatio=.02, earMean=.30,
                 earStdDev=.01, earMin=.28, earMax=.32, earTrendPerSec=0, blinkRate=15, msSinceLastBlink=2000,
                 perclos=.02, mouthMean=.08, mouthMax=.10, mouthTrendPerSec=0, noseDropMean=.45)
    drowsy = dict(awake, ear=.12, earL=.12, earR=.12, earMean=.13, earMin=.10, earMax=.16, perclos=.5,
                  blinkRate=5, msSinceLastBlink=6000)
    named = [("awake", awake), ("drowsy", drowsy), ("awake_no_blink_sentinel", dict(awake, msSinceLastBlink=-1))]
    vecs = [[d[k] for k in FEATURE_ORDER] for _, d in named]
    rng = np.random.RandomState(0)
    vecs += rng.uniform(-0.1, 1.0, (40, len(FEATURE_ORDER))).round(4).tolist()
    x = np.asarray(vecs, dtype=np.float32)
    sess = ort.InferenceSession(str(MODEL_PATH), providers=["CPUExecutionProvider"])
    p1 = sess.run(["probabilities"], {"features": x})[0][:, 1]
    assert idx  # ordem vem do schema
    return {"model_sha256": hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(), "tolerance": 1e-4,
            "vectors": x.tolist(), "expected_p_drowsy": [float(v) for v in p1],
            "named": {n: i for i, (n, _) in enumerate(named)}}


def main() -> None:
    if MODEL_PATH.exists():
        ONNX_OUT.write_text(json.dumps(onnx_fixture(), indent=1), encoding="utf-8")
        print(f"[ok] {ONNX_OUT}")
    fixture = {
        "description": "Gerado por ml/scripts/make_golden_fixture.py. Não editar à mão.",
        "tolerance": 1e-9,
        "frames": frames_fixture(),
        "blinkSequence": blink_fixture(),
    }
    OUT.write_text(json.dumps(fixture, indent=1), encoding="utf-8")
    print(f"[ok] {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
