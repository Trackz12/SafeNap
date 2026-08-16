"""Gera um modelo ONNX realista para drowsiness detection.

Treina um RandomForest em dados sintéticos que simulam padrões reais
de EAR/PERCLOS/bocejo para olhos abertos vs sonolentos.

Uso:
    python scripts/generate_realistic_model.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:
    sys.exit("pip install scikit-learn skl2onnx onnx")

from features.schema import FEATURE_ORDER, NUM_FEATURES

# Índices das features no FEATURE_ORDER
IDX = {name: i for i, name in enumerate(FEATURE_ORDER)}


def generate_realistic_data(n_per_class: int = 1500, seed: int = 42):
    rng = np.random.RandomState(seed)
    n = n_per_class

    # ---- CLASSE 0: ALERTA (olhos abertos) ----
    X0 = np.zeros((n, NUM_FEATURES), dtype=np.float32)

    # EAR alto e estável (0.28 - 0.40)
    ear_base = rng.normal(0.34, 0.03, n)
    X0[:, IDX['ear']] = ear_base
    X0[:, IDX['earL']] = ear_base + rng.normal(0, 0.01, n)
    X0[:, IDX['earR']] = ear_base + rng.normal(0, 0.01, n)

    # Mouth: boca fechada (0.05 - 0.25)
    X0[:, IDX['mouthAspect']] = rng.uniform(0.05, 0.25, n)
    X0[:, IDX['mouthMean']] = rng.uniform(0.05, 0.20, n)
    X0[:, IDX['mouthMax']] = rng.uniform(0.10, 0.30, n)

    # Nose: cabeça estável
    X0[:, IDX['noseDropRatio']] = rng.uniform(0.0, 0.08, n)
    X0[:, IDX['noseDropMean']] = rng.uniform(0.0, 0.06, n)

    # Yaw: cabeça centrada
    X0[:, IDX['yawRatio']] = rng.uniform(0.0, 0.15, n)

    # Histórico EAR: estável, pouca variância
    X0[:, IDX['earMean']] = ear_base + rng.normal(0, 0.01, n)
    X0[:, IDX['earStdDev']] = rng.uniform(0.005, 0.025, n)
    X0[:, IDX['earMin']] = ear_base - rng.uniform(0.02, 0.06, n)
    X0[:, IDX['earMax']] = ear_base + rng.uniform(0.02, 0.05, n)
    X0[:, IDX['earTrendPerSec']] = rng.normal(0, 0.01, n)

    # Blink: regular (12-20/min), duração curta
    X0[:, IDX['blinkRate']] = rng.uniform(12, 20, n)
    X0[:, IDX['msSinceLastBlink']] = rng.uniform(500, 4000, n)

    # PERCLOS baixo (< 10%)
    X0[:, IDX['perclos']] = rng.uniform(0.0, 0.10, n)

    # ---- CLASSE 1: SONOLENTO (olhos fechados / pesados) ----
    X1 = np.zeros((n, NUM_FEATURES), dtype=np.float32)

    # EAR baixo (0.08 - 0.22)
    ear_drowsy = rng.normal(0.14, 0.04, n)
    X1[:, IDX['ear']] = ear_drowsy
    X1[:, IDX['earL']] = ear_drowsy + rng.normal(0, 0.02, n)
    X1[:, IDX['earR']] = ear_drowsy + rng.normal(0, 0.02, n)

    # Mouth: bocejos frequentes
    yawn_mask = rng.random(n) < 0.3
    X1[:, IDX['mouthAspect']] = np.where(
        yawn_mask,
        rng.uniform(0.55, 0.85, n),
        rng.uniform(0.05, 0.30, n),
    )
    X1[:, IDX['mouthMean']] = np.where(
        yawn_mask,
        rng.uniform(0.45, 0.70, n),
        rng.uniform(0.05, 0.25, n),
    )
    X1[:, IDX['mouthMax']] = np.where(
        yawn_mask,
        rng.uniform(0.60, 0.90, n),
        rng.uniform(0.10, 0.35, n),
    )

    # Nose: cabeça caindo
    X1[:, IDX['noseDropRatio']] = rng.uniform(0.10, 0.35, n)
    X1[:, IDX['noseDropMean']] = rng.uniform(0.08, 0.30, n)

    # Yaw: cabeça pode balançar
    X1[:, IDX['yawRatio']] = rng.uniform(0.0, 0.25, n)

    # Histórico EAR: baixo e instável
    X1[:, IDX['earMean']] = ear_drowsy + rng.normal(0, 0.02, n)
    X1[:, IDX['earStdDev']] = rng.uniform(0.02, 0.06, n)
    X1[:, IDX['earMin']] = ear_drowsy - rng.uniform(0.03, 0.08, n)
    X1[:, IDX['earMax']] = ear_drowsy + rng.uniform(0.03, 0.08, n)
    X1[:, IDX['earTrendPerSec']] = rng.normal(-0.005, 0.02, n)

    # Blink: irregular ou ausente
    X1[:, IDX['blinkRate']] = rng.uniform(2, 12, n)
    X1[:, IDX['msSinceLastBlink']] = rng.uniform(1000, 12000, n)

    # PERCLOS alto (> 25%)
    X1[:, IDX['perclos']] = rng.uniform(0.25, 0.80, n)

    X = np.vstack([X0, X1])
    y = np.concatenate([np.zeros(n, dtype=np.int64), np.ones(n, dtype=np.int64)])

    return X, y


def main():
    out_dir = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "drowsiness.onnx"

    print("Gerando dados sintéticos realistas...")
    X, y = generate_realistic_data()
    print(f"  {len(y)} amostras: {int((1-y).sum())} alerta, {int(y.sum())} sonolento")

    print("Treinando RF...")
    clf = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        min_samples_leaf=3,
        class_weight='balanced',
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X, y)

    acc = clf.score(X, y)
    print(f"  Accuracy (treino): {acc:.4f}")

    scores = cross_val_score(clf, X, y, cv=5, scoring='accuracy')
    print(f"  Accuracy (5-fold CV): {scores.mean():.4f} ± {scores.std():.4f}")

    print("Exportando ONNX...")
    initial_type = [('features', FloatTensorType([None, NUM_FEATURES]))]
    onx = convert_sklearn(clf, initial_types=initial_type,
                          target_opset=19,
                          options={'zipmap': False})
    out_path.write_bytes(onx.SerializeToString())

    size_kb = out_path.stat().st_size / 1024
    print(f"[ok] modelo gerado -> {out_path} ({size_kb:.1f} KB)")

    import onnxruntime as ort
    sess = ort.InferenceSession(str(out_path), providers=['CPUExecutionProvider'])
    dummy_alert = np.zeros((1, NUM_FEATURES), dtype=np.float32)
    dummy_alert[0, IDX['ear']] = 0.34
    dummy_alert[0, IDX['earL']] = 0.34
    dummy_alert[0, IDX['earR']] = 0.34
    dummy_alert[0, IDX['perclos']] = 0.05

    dummy_drowsy = np.zeros((1, NUM_FEATURES), dtype=np.float32)
    dummy_drowsy[0, IDX['ear']] = 0.12
    dummy_drowsy[0, IDX['earL']] = 0.12
    dummy_drowsy[0, IDX['earR']] = 0.12
    dummy_drowsy[0, IDX['perclos']] = 0.55

    inp = sess.get_inputs()[0].name
    p_alert = sess.run(None, {inp: dummy_alert})[1][0]
    p_drowsy = sess.run(None, {inp: dummy_drowsy})[1][0]
    print(f"  Teste alerta:   class0={p_alert[0]:.4f}, class1={p_alert[1]:.4f}")
    print(f"  Teste sonolento: class0={p_drowsy[0]:.4f}, class1={p_drowsy[1]:.4f}")


if __name__ == "__main__":
    main()
