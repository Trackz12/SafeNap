"""Testa a MÁQUINA de treino (split por pessoa, métricas, export, reprodutibilidade).

Os dados aqui são sintéticos e servem só para exercitar o pipeline: nenhum número
deste arquivo é evidência de desempenho de detecção de sonolência.
"""

import json

import numpy as np
import pandas as pd
import pytest

from features.schema import FEATURE_ORDER
from train_model import load_dataset, subject_holdout, train

IDX = {n: i for i, n in enumerate(FEATURE_ORDER)}


def make_csv(path, n_subjects=12, per_class=50, seed=0):
    rng = np.random.RandomState(seed)
    rows = []
    for s in range(n_subjects):
        offset = rng.normal(0, 0.02, len(FEATURE_ORDER))
        for label in (0, 1):
            x = rng.normal(0.3, 0.05, (per_class, len(FEATURE_ORDER))) + offset
            x[:, IDX["perclos"]] = rng.uniform(0.0, 0.1, per_class) + 0.3 * label
            x[:, IDX["ear"]] -= 0.08 * label
            for r in x:
                rows.append({"subject_id": f"s{s}", "video_id": f"v{s}_{label}", "t_ms": 0,
                             **dict(zip(FEATURE_ORDER, r)), "label": label})
    pd.DataFrame(rows).to_csv(path, index=False)
    return path


def test_subject_holdout_never_shares_a_subject(tmp_path):
    df = load_dataset(make_csv(tmp_path / "d.csv"))
    tr, te = subject_holdout(df, 0.25, seed=7)
    s_tr, s_te = set(df.iloc[tr]["subject_id"]), set(df.iloc[te]["subject_id"])
    assert s_tr and s_te and not (s_tr & s_te)
    assert set(df.iloc[tr]["label"]) == set(df.iloc[te]["label"]) == {0, 1}


def test_train_writes_artifacts_with_provenance_and_onnx_parity(tmp_path):
    out = tmp_path / "run"
    res = train(make_csv(tmp_path / "d.csv"), out, seed=1, test_size=0.25, folds=3)
    assert {p.name for p in out.iterdir()} == {"drowsiness.onnx", "model_card.json", "metrics.json"}

    card = json.loads((out / "model_card.json").read_text(encoding="utf-8"))
    assert card["features"] == FEATURE_ORDER and card["seed"] == 1
    assert card["status"].startswith("EXPERIMENTAL")
    assert not set(card["split"]["train_subjects"]) & set(card["split"]["test_subjects"])
    assert card["dataset"]["rows"] == 12 * 100 and len(card["dataset"]["sha256"]) == 64
    assert card["onnx"]["max_abs_prob_diff"] < 1e-4 and card["onnx"]["outputs"] == ["label", "probabilities"]
    assert {"python", "numpy", "scikit-learn", "onnxruntime"} <= set(card["libraries"])

    assert set(res["cv"]) == {"logistic_regression", "decision_tree", "random_forest", "gradient_boosting"}
    t = res["test"]
    assert t["drowsy"]["recall_sensitivity"] is not None and t["roc_auc"] is not None
    assert sum(sum(r) for r in t["confusion_matrix"]["rows_true_cols_pred"]) == t["n"]


def test_training_is_reproducible_same_seed_same_onnx_bytes(tmp_path):
    csv = make_csv(tmp_path / "d.csv")
    a = train(csv, tmp_path / "a", seed=3, test_size=0.25, folds=3)
    b = train(csv, tmp_path / "b", seed=3, test_size=0.25, folds=3)
    assert a["card"]["onnx"]["sha256"] == b["card"]["onnx"]["sha256"]
    assert a["test"] == b["test"] and a["cv"] == b["cv"]


def test_dataset_validation_rejects_bad_input(tmp_path):
    good = pd.read_csv(make_csv(tmp_path / "d.csv"))

    nan = good.copy()
    nan.loc[0, "perclos"] = np.nan
    nan.to_csv(tmp_path / "nan.csv", index=False)
    with pytest.raises(ValueError, match="NaN"):
        load_dataset(tmp_path / "nan.csv")

    bad_label = good.copy()
    bad_label.loc[0, "label"] = 2
    bad_label.to_csv(tmp_path / "lab.csv", index=False)
    with pytest.raises(ValueError, match="label"):
        load_dataset(tmp_path / "lab.csv")

    good.drop(columns=["subject_id"]).to_csv(tmp_path / "nosub.csv", index=False)
    with pytest.raises(ValueError, match="subject_id"):
        load_dataset(tmp_path / "nosub.csv")

    few = pd.read_csv(make_csv(tmp_path / "few.csv", n_subjects=3))
    with pytest.raises(ValueError, match="sujeitos"):
        subject_holdout(few, 0.25, seed=1)


def test_evaluate_refuses_training_subjects(tmp_path):
    from evaluate import evaluate
    csv = make_csv(tmp_path / "d.csv")
    res = train(csv, tmp_path / "run", seed=1, test_size=0.25, folds=3)
    card = tmp_path / "run" / "model_card.json"
    onnx = tmp_path / "run" / "drowsiness.onnx"
    df = pd.read_csv(csv)

    test_only = df[df["subject_id"].isin(res["card"]["split"]["test_subjects"])]
    test_only.to_csv(tmp_path / "test.csv", index=False)
    assert evaluate(onnx, tmp_path / "test.csv", 0.5, card)["n"] == len(test_only)

    with pytest.raises(ValueError, match="vazamento"):
        evaluate(onnx, csv, 0.5, card)                     # CSV completo inclui sujeitos de treino
