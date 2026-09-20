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
            for i, r in enumerate(x):
                rows.append({"subject_id": f"s{s}", "video_id": f"v{s}_{label}", "t_ms": 100 * i,
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
    assert {p.name for p in out.iterdir()} == {"drowsiness.onnx", "model_card.json", "metrics.json",
                                               "experiment.json", "confusion_matrix.csv"}

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


# --- vazamento de grupos, contagens, unidade de avaliação e relatório -------------------------

def test_assert_disjoint_fails_when_a_subject_is_in_both_sets():
    from train_model import assert_disjoint
    assert_disjoint("treino", ["a", "b"], "teste", ["c"])            # disjuntos: ok
    with pytest.raises(ValueError, match="vazamento de grupos"):
        assert_disjoint("treino", ["a", "b"], "teste", ["b", "c"])   # 'b' nos dois


def test_every_cv_fold_keeps_validation_subjects_out_of_training():
    from train_model import group_folds
    groups = np.array([f"s{i % 8}" for i in range(400)])
    folds = list(group_folds(groups, 4))
    assert len(folds) == 4
    for tr, va in folds:
        assert not set(groups[tr]) & set(groups[va])
    # cada sujeito é validado exatamente uma vez
    assert sorted(s for _, va in folds for s in set(groups[va])) == sorted(set(groups))


def test_train_test_and_validation_subject_sets_are_pairwise_disjoint(tmp_path):
    """train ∩ test = ∅ (holdout) e, dentro do treino, validação(fold) ∩ treino(fold) = ∅."""
    from train_model import group_folds
    df = load_dataset(make_csv(tmp_path / "d.csv"))
    tr, te = subject_holdout(df, 0.25, seed=5)
    g = df["subject_id"].astype(str).to_numpy()
    assert not set(g[tr]) & set(g[te])
    for f_tr, f_va in group_folds(g[tr], 3):
        assert not set(g[tr][f_tr]) & set(g[tr][f_va])
        assert not set(g[tr][f_va]) & set(g[te])                  # validação também nunca toca o teste


def test_report_answers_where_the_metric_came_from(tmp_path):
    out = tmp_path / "run"
    train(make_csv(tmp_path / "d.csv"), out, seed=2, test_size=0.25, folds=3, dataset_name="sintético-de-teste")
    exp = json.loads((out / "experiment.json").read_text(encoding="utf-8"))
    assert exp["seed"] == 2 and exp["dataset"]["name"] == "sintético-de-teste"
    assert exp["config"]["selected"] in exp["config"]["candidates"]
    assert exp["split"]["subject_leakage"] == 0
    tr, te = exp["split"]["train"], exp["split"]["test"]
    assert tr["subjects"] + te["subjects"] == 12 and tr["rows"] + te["rows"] == 1200
    assert tr["positive_rows(drowsy)"] + tr["negative_rows(alert)"] == tr["rows"]
    assert exp["model_version"].endswith("-s2") and exp["model_version"].startswith(exp["config"]["selected"])

    metrics = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
    assert "window" in metrics["evaluation_units"]["holdout_test"]
    rows = (out / "confusion_matrix.csv").read_text(encoding="utf-8").splitlines()
    assert rows[0] == "true/pred,alert(0),drowsy(1)" and len(rows) == 3


def test_clip_level_metrics_only_when_there_is_a_basis(tmp_path):
    from train_model import clip_level_metrics
    df = load_dataset(make_csv(tmp_path / "d.csv"))           # 1 clipe por (sujeito, classe)
    prob = np.where(df["label"] == 1, 0.9, 0.1)
    ok = clip_level_metrics(df, prob, 0.5)
    assert ok["available"] and ok["metrics"]["accuracy"] == 1.0
    assert ok["metrics"]["n"] == 12 * 2                       # 24 clipes, não 1200 janelas

    one_each = df[df["subject_id"] == "s0"]
    no = clip_level_metrics(one_each, np.where(one_each["label"] == 1, 0.9, 0.1), 0.5)
    assert no["available"] is False and "clipes" in no["reason"]
    assert clip_level_metrics(df.drop(columns=["video_id"]), prob, 0.5)["available"] is False


# --- vazamento INDIRETO (vídeo/clipe/duplicatas) e validação do CSV na entrada ---------------------

def test_cv_folds_fail_if_the_same_video_sits_on_both_sides_even_with_distinct_subjects():
    from train_model import group_folds
    groups = np.array(["a"] * 10 + ["b"] * 10 + ["c"] * 10 + ["d"] * 10)
    videos = np.array(["va"] * 10 + ["vb"] * 10 + ["vc"] * 10 + ["vd"] * 10)
    assert len(list(group_folds(groups, 4, videos))) == 4               # vídeos próprios: ok
    shared = videos.copy()
    shared[10:20] = "va"                                                # sujeito b reusa o vídeo de a
    with pytest.raises(ValueError, match="vazamento de grupos"):
        list(group_folds(groups, 4, shared))


def test_load_dataset_fails_on_ambiguous_identity_or_duplicated_frames(tmp_path):
    good = pd.read_csv(make_csv(tmp_path / "d.csv"))

    dup_frames = pd.concat([good, good.iloc[[0]]], ignore_index=True)
    dup_frames.to_csv(tmp_path / "dup.csv", index=False)
    with pytest.raises(ValueError, match="repetido"):
        load_dataset(tmp_path / "dup.csv")

    shared_video = good.copy()
    shared_video.loc[shared_video["subject_id"] == "s1", "video_id"] = "v0_0"      # vídeo de s0 também em s1
    shared_video.to_csv(tmp_path / "shared.csv", index=False)
    with pytest.raises(ValueError, match="mais de um sujeito"):
        load_dataset(tmp_path / "shared.csv")

    doubt = good.copy()
    doubt.loc[doubt["subject_id"] == "s1", "subject_id"] = "s01"                  # 's01' ~ 's1'
    doubt = pd.concat([doubt, good[good["subject_id"] == "s1"].assign(video_id=lambda d: "x" + d["video_id"])])
    doubt.to_csv(tmp_path / "doubt.csv", index=False)
    with pytest.raises(ValueError, match="identidade de sujeito duvidosa"):
        load_dataset(tmp_path / "doubt.csv")

    good.drop(columns=["t_ms"]).to_csv(tmp_path / "not.csv", index=False)
    with pytest.raises(ValueError, match="t_ms"):
        load_dataset(tmp_path / "not.csv")


def test_report_records_zero_video_and_clip_leakage(tmp_path):
    out = tmp_path / "run"
    train(make_csv(tmp_path / "d.csv"), out, seed=4, test_size=0.25, folds=3)
    split = json.loads((out / "experiment.json").read_text(encoding="utf-8"))["split"]
    assert (split["subject_leakage"], split["video_leakage"], split["clip_leakage"]) == (0, 0, 0)
    assert split["train"]["clips"] + split["test"]["clips"] == 24

