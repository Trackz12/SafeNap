"""Avalia o modelo ONNX exportado contra um CSV de teste.

Uso:
    python scripts/evaluate.py --model ../frontend/public/models/drowsiness.onnx \
        --data ../data/features/test.csv

Não requer sklearn — usa onnxruntime diretamente (validar no browser).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import onnxruntime as ort
except ImportError:
    sys.exit("pip install onnxruntime")

from features.schema import FEATURE_ORDER, NUM_FEATURES


def main() -> None:
    parser = argparse.ArgumentParser(description="Avalia modelo ONNX")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()

    sess = ort.InferenceSession(str(args.model), providers=['CPUExecutionProvider'])

    df = pd.read_csv(args.data)
    X = df[FEATURE_ORDER].fillna(-1).to_numpy(dtype=np.float32)
    y = df['label'].to_numpy()

    preds = []
    probs = []
    for row in X:
        inp = {sess.get_inputs()[0].name: row.reshape(1, NUM_FEATURES)}
        out = sess.run(None, inp)[0]
        preds.append(int(np.argmax(out[0])))
        probs.append(float(out[0][1]))

    acc = float(np.mean(np.array(preds) == y))
    tp = sum(1 for p, t in zip(preds, y) if p == 1 and t == 1)
    fp = sum(1 for p, t in zip(preds, y) if p == 1 and t == 0)
    fn = sum(1 for p, t in zip(preds, y) if p == 0 and t == 1)
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0

    print(f"Amostras: {len(y)}  (drowsy={int(y.sum())}, alerta={int((1 - y).sum())})")
    print(f"Accuracy: {acc:.4f}")
    print(f"Precision: {prec:.4f}  Recall: {rec:.4f}  F1: {f1:.4f}")

    # Distribuição de probabilidade drowsy
    qs = np.percentile(probs, [50, 75, 90, 95, 99])
    print(f"P50/P75/P90/P95/P99 drowsy prob: {[f'{q:.3f}' for q in qs]}")


if __name__ == "__main__":
    main()
