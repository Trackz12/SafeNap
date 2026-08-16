"""Gera um modelo ONNX dummy para teste do frontend.

Cria um RF treinado em dados sintéticos (aberto=0, sonolento=1) e exporta
para public/models/drowsiness.onnx.

Uso:
    python scripts/generate_dummy_model.py
"""

import sys
from pathlib import Path

# Adiciona o diretório pai ao path para importar features/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from sklearn.ensemble import RandomForestClassifier

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:
    sys.exit("pip install scikit-learn skl2onnx onnx")

from features.schema import FEATURE_ORDER, NUM_FEATURES


def generate_synthetic_data(n_samples: int = 2000, seed: int = 42):
    rng = np.random.RandomState(seed)
    X = rng.randn(n_samples, NUM_FEATURES).astype(np.float32)

    # Classificar: primeiras 6 features representam EAR atual dos olhos
    ear_features = X[:, :6].mean(axis=1)
    # Adicionar sinal: EAR baixo → sonolento
    y = (ear_features < -0.3).astype(np.int64)

    return X, y


def main():
    out_dir = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "drowsiness.onnx"

    print("Gerando dados sintéticos...")
    X, y = generate_synthetic_data()
    print(f"  {len(y)} amostras: {int(y.sum())} sonolento, {int((1-y).sum())} alerta")

    print("Treinando RF dummy...")
    clf = RandomForestClassifier(
        n_estimators=60,
        max_depth=8,
        min_samples_leaf=4,
        class_weight='balanced',
        random_state=42,
    )
    clf.fit(X, y)

    acc = clf.score(X, y)
    print(f"  Accuracy (treino): {acc:.4f}")

    print("Exportando ONNX...")
    initial_type = [('features', FloatTensorType([None, NUM_FEATURES]))]
    onx = convert_sklearn(clf, initial_types=initial_type,
                          target_opset=19,
                          options={'zipmap': False})
    out_path.write_bytes(onx.SerializeToString())

    size_kb = out_path.stat().st_size / 1024
    print(f"[ok] modelo gerado -> {out_path} ({size_kb:.1f} KB)")

    # Validação rápida
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out_path), providers=['CPUExecutionProvider'])
    dummy = np.zeros((1, NUM_FEATURES), dtype=np.float32)
    inp_name = sess.get_inputs()[0].name
    results = sess.run(None, {inp_name: dummy})
    probs = results[1]  # probabilities output
    print(f"  Inference: class0={probs[0][0]:.4f}, class1={probs[0][1]:.4f}")


if __name__ == "__main__":
    main()
