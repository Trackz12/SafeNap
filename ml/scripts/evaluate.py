"""Avalia um ONNX exportado contra um CSV de features (usa as probabilidades reais, não o label).

O ideal é avaliar em sujeitos que NÃO estiveram no treino (ver model_card.json → split.test_subjects).

Uso:
    python scripts/evaluate.py --model ../frontend/public/models/drowsiness.onnx --data ../data/features/test.csv [--threshold 0.5]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import onnxruntime as ort
import pandas as pd

from evaluation.metrics import binary_metrics  # noqa: E402
from features.schema import FEATURE_ORDER, SCHEMA_HASH  # noqa: E402


def check_no_train_subjects(df: pd.DataFrame, card_path: Path) -> list:
    """Sujeitos do CSV que estiveram no TREINO segundo o model card (avaliá-los infla as métricas)."""
    card = json.loads(card_path.read_text(encoding="utf-8"))
    if card.get("schema_hash") != SCHEMA_HASH:
        raise ValueError("schema_hash do model card difere do schema atual: ordem de features incompatível")
    train = set(map(str, card.get("split", {}).get("train_subjects", [])))
    return sorted(train & set(df["subject_id"].astype(str))) if "subject_id" in df else []


def evaluate(model_path: Path, csv_path: Path, threshold: float, card_path: Path = None) -> dict:
    df = pd.read_csv(csv_path)
    if card_path is not None:
        leaked = check_no_train_subjects(df, card_path)
        if leaked:
            raise ValueError(f"vazamento: sujeitos de treino no CSV de avaliação: {leaked[:5]}")
    X = df[FEATURE_ORDER].to_numpy(dtype=np.float32)
    if not np.isfinite(X).all():
        raise ValueError("features com NaN/Infinity no CSV")
    y = df["label"].to_numpy(dtype=int)
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    probs = sess.run(["probabilities"], {sess.get_inputs()[0].name: X})[0][:, 1]  # P(DROWSY)
    return binary_metrics(y, (probs >= threshold).astype(int), probs)


def main() -> None:
    p = argparse.ArgumentParser(description="Avalia modelo ONNX")
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--model-card", type=Path, default=None,
                   help="model_card.json: recusa avaliar sujeitos que estiveram no treino")
    a = p.parse_args()
    print(json.dumps(evaluate(a.model, a.data, a.threshold, a.model_card), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
