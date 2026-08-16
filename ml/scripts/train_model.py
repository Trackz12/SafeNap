"""Treina o Random Forest de sonolência e exporta para ONNX (quantizado).

Uso:
    python scripts/train_model.py --data ../data/features/all.csv \
        --out ../frontend/public/models/drowsiness.onnx

Requires: pip install -r requirements.txt
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (accuracy_score, classification_report,
                             confusion_matrix, f1_score, roc_auc_score)
from sklearn.model_selection import train_test_split

from features.schema import FEATURE_ORDER, NUM_FEATURES


def train_and_export(csv_path: Path, out_path: Path, n_estimators: int,
                     max_depth: int, random_state: int) -> None:
    df = pd.read_csv(csv_path)
    required = FEATURE_ORDER + ['label']
    missing = [c for c in required if c not in df.columns]
    if missing:
        sys.exit(f"[erro] colunas ausentes: {missing}")

    # Fill NaN defensivo (msSinceLastBlink sentinela = -1)
    X = df[FEATURE_ORDER].fillna(-1).to_numpy(dtype=np.float32)
    y = df['label'].to_numpy()

    print(f"Dataset: {len(df)} linhas, {len(y[y == 1])} drowsy, {len(y[y == 0])} alerta")
    if len(np.unique(y)) < 2:
        sys.exit("[erro] precisa de pelo menos 2 classes no dataset")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=random_state, stratify=y)

    clf = RandomForestClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        max_features='sqrt',
        min_samples_leaf=4,
        class_weight='balanced',
        n_jobs=-1,
        random_state=random_state,
    )
    clf.fit(X_train, y_train)

    y_pred = clf.predict(X_test)
    y_prob = clf.predict_proba(X_test)

    print("\n--- Avaliação ---")
    print(f"Accuracy:  {accuracy_score(y_test, y_pred):.4f}")
    print(f"F1:        {f1_score(y_test, y_pred, zero_division=0):.4f}")
    try:
        print(f"ROC-AUC:   {roc_auc_score(y_test, y_prob[:, 1]):.4f}")
    except ValueError:
        print("ROC-AUC:   N/A (apenas 1 classe no teste)")
    print(f"Matriz:\n{confusion_matrix(y_test, y_pred)}")
    print(classification_report(y_test, y_pred, zero_division=0, digits=3))

    # ── Export ONNX ──
    print("\n--- Export ONNX ---")
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
    except ImportError:
        sys.exit("pip install skl2onnx")

    initial_type = [('features', FloatTensorType([None, NUM_FEATURES]))]
    onx = convert_sklearn(clf, initial_types=initial_type,
                          target_opset=19, options={'zipmap': False})

    out_path.parent.mkdir(parents=True, exist_ok=True)
    onx_path = out_path.with_suffix('.onnx')
    onx_path.write_bytes(onx.SerializeToString())
    print(f"[ok] modelo ONNX → {onx_path} ({onx_path.stat().st_size / 1024:.1f} KB)")

    # Quantização (dinâmica, int8)
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        q_path = out_path
        quantize_dynamic(
            str(onx_path),
            str(q_path),
            weight_type=QuantType.QInt8,
            op_types_to_quantize=['MatMul', 'Gemm', 'Conv', 'Relu'],
        )
        print(f"[ok] quantizado → {q_path} ({q_path.stat().st_size / 1024:.1f} KB)")
    except Exception as e:
        print(f"[aviso] quantização falhou, usando não-quantizado: {e}")
        onx_path.rename(out_path)

    # Feature importances (report)
    importances = sorted(zip(FEATURE_ORDER, clf.feature_importances_),
                         key=lambda x: -x[1])
    print("\n--- Feature importances (top 8) ---")
    for name, imp in importances[:8]:
        print(f"  {name}: {imp:.4f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Treina RF e exporta ONNX")
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path,
                        default=Path("../frontend/public/models/drowsiness.onnx"))
    parser.add_argument("--estimators", type=int, default=100)
    parser.add_argument("--depth", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    train_and_export(args.data.resolve(), args.out.resolve(),
                     args.estimators, args.depth, args.seed)


if __name__ == "__main__":
    main()
