"""Gera o ONNX SINTÉTICO embarcado no frontend (EXPERIMENTAL — NÃO VALIDADO).

ATENÇÃO: este modelo NÃO foi treinado com pessoas reais. Ele aprende distribuições
escritas à mão em `generate_realistic_data` (EAR alto/baixo, PERCLOS, boca, cabeça).
Por construção as duas classes são quase perfeitamente separáveis (as árvores têm ~3
nós), então QUALQUER acurácia medida nesses dados é circular e não diz nada sobre
sonolência real. Consequência conhecida (docs/ML_PIPELINE.md): as faixas sintéticas de
`noseDropRatio` não correspondem à escala real do frontend, e um vetor de pessoa
acordada recebe P(drowsy) ≈ 0,39 em vez de ≈ 0.

Por isso o SafeNap trata o ML como sinal auxiliar: ele pode gerar WARNING, mas não
origina ALARM sozinho (frontend/src/ml/mlReasons.ts). O caminho para um modelo com
evidência experimental é scripts/extract_features.py → scripts/train_model.py com
NTHU-DDD / UTA-RLDD (não disponíveis neste repositório).

Uso (reproduz o artefato embarcado, byte a byte com as mesmas versões):
    python scripts/generate_realistic_model.py [--out-dir ../frontend/public/models]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import RandomForestClassifier

from features.schema import FEATURE_ORDER, NUM_FEATURES, SCHEMA_HASH
from train_model import ONNX_OPSET, export_onnx, library_versions, sha256_file, verify_onnx

SEED = 42
N_PER_CLASS = 1500
RF_PARAMS = dict(n_estimators=100, max_depth=10, min_samples_leaf=3, class_weight="balanced",
                 random_state=SEED, n_jobs=1)

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Gera o ONNX sintético embarcado (EXPERIMENTAL)")
    parser.add_argument("--out-dir", type=Path,
                        default=Path(__file__).resolve().parents[2] / "frontend" / "public" / "models")
    out_dir = parser.parse_args().out_dir
    out_path = out_dir / "drowsiness.onnx"

    print("[SINTÉTICO] gerando dados escritos à mão — NÃO são pessoas reais")
    X, y = generate_realistic_data(N_PER_CLASS, SEED)
    clf = RandomForestClassifier(**RF_PARAMS).fit(X, y)
    export_onnx(clf, out_path)
    parity = verify_onnx(clf, out_path, X[::20])

    card = {
        "status": "EXPERIMENTAL/SINTÉTICO — treinado apenas em dados sintéticos; NÃO validado",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": SEED, "model": "random_forest",
        "hyperparameters": {k: str(v) for k, v in RF_PARAMS.items()},
        "features": FEATURE_ORDER, "schema_hash": SCHEMA_HASH,
        "dataset": {"kind": "sintético (scripts/generate_realistic_model.py::generate_realistic_data)",
                    "rows": int(len(y)), "class_counts": {"alert(0)": int((y == 0).sum()), "drowsy(1)": int((y == 1).sum())}},
        "metrics": None,
        "metrics_note": "Deliberadamente ausentes: métricas em dados sintéticos são circulares e não medem sonolência real.",
        "known_limitations": [
            "noseDropRatio sintético (0–0,35) não cobre a escala real do frontend (~0,3–0,5): pessoa acordada pontua ≈ 0,39.",
            "Árvores com ~3 nós: o modelo é essencialmente limiares em poucas features.",
            "Nunca avaliado em NTHU-DDD, UTA-RLDD ou condutores reais.",
        ],
        "onnx": {"file": out_path.name, "sha256": sha256_file(out_path), "opset": ONNX_OPSET, **parity},
        "libraries": library_versions(),
    }
    (out_dir / "drowsiness.model-card.json").write_text(json.dumps(card, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] {out_path} ({out_path.stat().st_size / 1024:.1f} KB) sha256={card['onnx']['sha256'][:16]}…")
    print("     + drowsiness.model-card.json (status: EXPERIMENTAL/SINTÉTICO)")


if __name__ == "__main__":
    main()
