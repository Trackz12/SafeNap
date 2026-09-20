"""Treina, avalia e exporta o classificador de sonolência (reprodutível, split por pessoa).

Entrada: CSV de scripts/extract_features.py (colunas subject_id, video_id, t_ms, 18 features, label).

Protocolo (evita vazamento — janelas de um mesmo vídeo são quase idênticas):
  1. Sujeitos são divididos em TREINO e TESTE (holdout por pessoa; nenhum sujeito nos dois).
  2. Candidatos (LogReg, Decision Tree, Random Forest, Gradient Boosting) são comparados por
     validação cruzada AGRUPADA por sujeito (GroupKFold) só nos sujeitos de treino.
  3. O melhor por PR-AUC (classe DROWSY; robusto a desbalanceamento) é reajustado no treino e
     avaliado UMA vez no teste. Esse é o modelo exportado (nunca o "treino+teste", para o
     model card descrever exatamente o artefato que foi avaliado).
  4. Exporta ONNX (sem quantização: árvores não têm MatMul/Gemm), confere paridade sklearn↔ONNX
     Runtime e o contrato de I/O que o frontend assume (entrada [N,18], saídas label/probabilities,
     classes [0,1]), e grava model_card.json + metrics.json.

UNIDADE DE AVALIAÇÃO (explícita em metrics.json -> "evaluation_units"):
  - "window": cada LINHA do CSV = as 18 features de UMA janela (~1 s) que termina num frame. É a
    unidade de `holdout_test` e `cv_train_subjects`. Janelas vizinhas são quase idênticas
    (autocorrelação): o número efetivo de observações independentes é o de VÍDEOS/SUJEITOS, não o de linhas.
  - "clip": um par (video_id, label): probabilidade média das janelas do clipe >= limiar -> decisão do
    clipe. É `holdout_test_clip_level`; só existe se o teste tiver >= 2 clipes de cada classe.
  Nenhuma dessas é métrica "por pessoa"; o número de pessoas de teste fica em split.test.subjects.

Relatório reproduzível em --out-dir: model_card.json, metrics.json, experiment.json,
confusion_matrix.csv, drowsiness.onnx.

Uso:
    python scripts/train_model.py --data ../data/features/all.csv --out-dir ../reports/ml/run1 \
        --dataset-name "UTA-RLDD (0/10)" [--deploy ../frontend/public/models]
"""

import argparse
import hashlib
import json
import platform
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from dataset_adapters.validation import validate_features  # noqa: E402
from evaluation.metrics import binary_metrics  # noqa: E402
from features.schema import FEATURE_ORDER, NUM_FEATURES, SCHEMA_HASH  # noqa: E402

DEFAULT_SEED = 42
DEFAULT_THRESHOLD = 0.5
ONNX_OPSET = 19
ONNX_GRAPH_NAME = "safenap_drowsiness"
PARITY_TOLERANCE = 1e-4  # float32 no ORT vs float64 no sklearn


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_dataset(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    missing = [c for c in FEATURE_ORDER + ["label", "subject_id"] if c not in df.columns]
    if missing:
        raise ValueError(f"colunas ausentes no CSV: {missing}")
    if not np.isfinite(df[FEATURE_ORDER].to_numpy(dtype=float)).all():
        raise ValueError("features com NaN/Infinity no CSV — corrija a extração, não preencha com 0")
    if not set(df["label"].unique()) <= {0, 1}:
        raise ValueError("label deve ser 0 (alerta) ou 1 (sonolento)")
    if df["label"].nunique() < 2:
        raise ValueError("precisa das duas classes")
    # vazamento indireto e integridade (ids, timestamps, mistura de sujeitos, vetores duplicados)
    validate_features(df, FEATURE_ORDER).raise_if_errors()
    return df


def assert_disjoint(name_a: str, groups_a, name_b: str, groups_b) -> None:
    """Falha (ValueError) se algum grupo (sujeito) aparecer nos dois conjuntos — vazamento."""
    shared = set(map(str, groups_a)) & set(map(str, groups_b))
    if shared:
        raise ValueError(f"vazamento de grupos: {sorted(shared)[:5]} em '{name_a}' e '{name_b}'")


def subject_holdout(df: pd.DataFrame, test_size: float, seed: int) -> Tuple[np.ndarray, np.ndarray]:
    """Índices (treino, teste) com sujeitos disjuntos e as duas classes em ambos os lados."""
    from sklearn.model_selection import GroupShuffleSplit
    if df["subject_id"].nunique() < 4:
        raise ValueError("split por pessoa exige >= 4 sujeitos distintos")
    groups = df["subject_id"].astype(str).to_numpy()
    y = df["label"].to_numpy()
    for attempt in range(200):  # semente derivada: determinística, mas garante as 2 classes nos dois lados
        gss = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=seed + attempt)
        tr, te = next(gss.split(np.zeros(len(df)), y, groups))
        if len(set(y[tr])) == 2 and len(set(y[te])) == 2:
            assert_disjoint("treino", groups[tr], "teste", groups[te])
            return tr, te
    raise ValueError("não achei split por pessoa com as duas classes em treino e teste")


def candidates(seed: int) -> Dict[str, object]:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.tree import DecisionTreeClassifier
    return {
        "logistic_regression": make_pipeline(
            StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000, random_state=seed)),
        "decision_tree": DecisionTreeClassifier(
            max_depth=6, min_samples_leaf=20, class_weight="balanced", random_state=seed),
        "random_forest": RandomForestClassifier(
            n_estimators=100, max_depth=8, min_samples_leaf=20, max_features="sqrt",
            class_weight="balanced", n_jobs=1, random_state=seed),
        "gradient_boosting": GradientBoostingClassifier(
            n_estimators=100, max_depth=3, learning_rate=0.1, subsample=0.8, random_state=seed),
    }


def group_folds(groups: np.ndarray, n_splits: int, videos: Optional[np.ndarray] = None):
    """(treino, validação) por sujeito; cada fold é verificado: validação nunca compartilha sujeito
    (nem, se `videos` for dado, vídeo) com treino."""
    from sklearn.model_selection import GroupKFold
    for tr, va in GroupKFold(n_splits=n_splits).split(np.zeros(len(groups)), groups=groups):
        assert_disjoint("treino(fold)", groups[tr], "validação(fold)", groups[va])
        if videos is not None:
            assert_disjoint("treino(fold, vídeo)", videos[tr], "validação(fold, vídeo)", videos[va])
        yield tr, va


def cross_validate(estimator, X: np.ndarray, y: np.ndarray, groups: np.ndarray, folds: int,
                   videos: Optional[np.ndarray] = None) -> Dict[str, object]:
    from sklearn.base import clone
    n_splits = min(folds, len(set(groups)))
    oof = np.full(len(y), np.nan)
    for tr, va in group_folds(groups, n_splits, videos):
        if len(set(y[tr])) < 2:
            continue
        m = clone(estimator).fit(X[tr], y[tr])
        oof[va] = m.predict_proba(X[va])[:, 1]
    ok = ~np.isnan(oof)
    return binary_metrics(y[ok], (oof[ok] >= DEFAULT_THRESHOLD).astype(int), oof[ok])


def export_onnx(model, out_path: Path) -> None:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    onx = convert_sklearn(model, initial_types=[("features", FloatTensorType([None, NUM_FEATURES]))],
                          target_opset=ONNX_OPSET, options={"zipmap": False})
    # skl2onnx grava um UUID aleatório em graph.name; sem normalizar, a mesma seed gera bytes diferentes.
    onx.graph.name = ONNX_GRAPH_NAME
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(onx.SerializeToString())


def verify_onnx(model, onnx_path: Path, X: np.ndarray) -> Dict[str, object]:
    """Contrato de I/O que o frontend assume + paridade numérica com o sklearn."""
    import onnx
    import onnxruntime as ort
    g = onnx.load(str(onnx_path)).graph
    in_dims = [d.dim_value or d.dim_param for d in g.input[0].type.tensor_type.shape.dim]
    assert g.input[0].name == "features" and in_dims[1] == NUM_FEATURES, f"entrada inesperada: {in_dims}"
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    assert [o.name for o in sess.get_outputs()] == ["label", "probabilities"], "saídas ≠ (label, probabilities)"
    onnx_p = sess.run(None, {"features": X.astype(np.float32)})[1]
    assert onnx_p.shape == (len(X), 2), f"probabilities shape {onnx_p.shape}"
    sk_p = model.predict_proba(X.astype(np.float32))
    assert list(model.classes_) == [0, 1], f"classes {model.classes_}"
    diff = float(np.max(np.abs(onnx_p - sk_p)))
    if diff > PARITY_TOLERANCE:
        raise AssertionError(f"ONNX diverge do sklearn: max|Δp|={diff:.2e} > {PARITY_TOLERANCE}")
    return {"max_abs_prob_diff": diff, "input_shape": in_dims, "outputs": ["label", "probabilities"]}


def library_versions() -> Dict[str, str]:
    import onnx, onnxruntime, sklearn, skl2onnx  # noqa: E401
    return {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__,
            "scikit-learn": sklearn.__version__, "skl2onnx": skl2onnx.__version__,
            "onnx": onnx.__version__, "onnxruntime": onnxruntime.__version__}


def partition_summary(df: pd.DataFrame, idx: np.ndarray) -> Dict[str, object]:
    """Contagens de uma partição: quem e quanto entrou (para o relatório responder 'de onde saiu?')."""
    part = df.iloc[idx]
    has_video = "video_id" in part
    return {"subjects": int(part["subject_id"].nunique()),
            "videos": int(part["video_id"].nunique()) if has_video else None,
            "clips": int(len(part[["video_id", "label"]].drop_duplicates())) if has_video else None,
            "rows": int(len(part)),
            "positive_rows(drowsy)": int((part["label"] == 1).sum()),
            "negative_rows(alert)": int((part["label"] == 0).sum())}


def clip_level_metrics(df_test: pd.DataFrame, prob: np.ndarray, threshold: float) -> Dict[str, object]:
    """Decisão por CLIPE (video_id, label): média das probabilidades das janelas >= limiar.
    Devolve {"available": False, "reason": ...} se não houver base para estimar (não inventa)."""
    if "video_id" not in df_test:
        return {"available": False, "reason": "CSV sem coluna video_id"}
    agg = df_test.assign(p=prob).groupby(["video_id", "label"], as_index=False)["p"].mean()
    per_class = agg["label"].value_counts()
    if len(per_class) < 2 or int(per_class.min()) < 2:
        return {"available": False,
                "reason": f"precisa de >= 2 clipes de teste por classe; há {per_class.to_dict()}"}
    m = binary_metrics(agg["label"].to_numpy(dtype=int), (agg["p"] >= threshold).astype(int).to_numpy(),
                       agg["p"].to_numpy())
    return {"available": True, "unit": "clip (video_id, label); prob. média das janelas", "metrics": m}


def model_version(best: str, dataset_sha: str, seed: int) -> str:
    return f"{best}-{SCHEMA_HASH[:8]}-{dataset_sha[:8]}-s{seed}"


def write_confusion_matrix_csv(path: Path, test: Dict[str, object]) -> None:
    (tn, fp), (fn, tp) = test["confusion_matrix"]["rows_true_cols_pred"]
    path.write_text(f"true/pred,alert(0),drowsy(1)\nalert(0),{tn},{fp}\ndrowsy(1),{fn},{tp}\n", encoding="utf-8")


def train(csv_path: Path, out_dir: Path, seed: int, test_size: float, folds: int,
          dataset_name: str = "não informado") -> Dict[str, object]:
    from sklearn.base import clone
    df = load_dataset(csv_path)
    tr, te = subject_holdout(df, test_size, seed)
    X = df[FEATURE_ORDER].to_numpy(dtype=np.float64)
    y = df["label"].to_numpy(dtype=int)
    g = df["subject_id"].astype(str).to_numpy()
    v = df["video_id"].astype(str).to_numpy()
    c = (df["video_id"].astype(str) + "#" + df["label"].astype(str)).to_numpy()
    # vazamento indireto: mesmo vídeo ou mesmo clipe em treino e teste => FALHA (mesmo que o sujeito esteja ok)
    assert_disjoint("treino(vídeo)", v[tr], "teste(vídeo)", v[te])
    assert_disjoint("treino(clipe)", c[tr], "teste(clipe)", c[te])

    cv = {name: cross_validate(est, X[tr], y[tr], g[tr], folds, v[tr]) for name, est in candidates(seed).items()}
    best = max(cv, key=lambda n: (cv[n]["pr_auc"] or 0.0, cv[n]["drowsy"]["recall_sensitivity"] or 0.0))

    model = clone(candidates(seed)[best]).fit(X[tr], y[tr])
    prob = model.predict_proba(X[te])[:, 1]
    test = binary_metrics(y[te], (prob >= DEFAULT_THRESHOLD).astype(int), prob)
    clip_test = clip_level_metrics(df.iloc[te], prob, DEFAULT_THRESHOLD)

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "drowsiness.onnx"
    export_onnx(model, onnx_path)
    parity = verify_onnx(model, onnx_path, X[te])

    dataset_sha = sha256_file(csv_path)
    version = model_version(best, dataset_sha, seed)
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    split = {"kind": "holdout por sujeito + GroupKFold no treino (a validação é o out-of-fold do GroupKFold)",
             "test_size": test_size, "cv_folds": folds,
             "train": {**partition_summary(df, tr), "subject_ids": sorted(set(g[tr]))},
             "test": {**partition_summary(df, te), "subject_ids": sorted(set(g[te]))},
             "subject_leakage": 0, "video_leakage": 0, "clip_leakage": 0}  # assert_disjoint já abortou se > 0
    card = {
        "status": "EXPERIMENTAL — avaliado só no dataset informado; não validado em condutores reais",
        "model_version": version,
        "created_at": created,
        "seed": seed,
        "model": best,
        "hyperparameters": {k: str(v) for k, v in model.get_params().items() if not k.startswith("steps")},
        "features": FEATURE_ORDER, "schema_hash": SCHEMA_HASH,
        "dataset": {"name": dataset_name, "file": csv_path.name, "sha256": dataset_sha, "rows": len(df),
                    "subjects": int(df["subject_id"].nunique()),
                    "videos": int(df["video_id"].nunique()) if "video_id" in df else None,
                    "class_counts": {"alert(0)": int((y == 0).sum()), "drowsy(1)": int((y == 1).sum())}},
        # chaves antigas (evaluate.py lê split.train_subjects/test_subjects)
        "split": {**split, "train_subjects": split["train"]["subject_ids"],
                  "test_subjects": split["test"]["subject_ids"],
                  "train_rows": int(len(tr)), "test_rows": int(len(te))},
        "decision_threshold": DEFAULT_THRESHOLD,
        "onnx": {"file": onnx_path.name, "sha256": sha256_file(onnx_path), "opset": ONNX_OPSET, **parity},
        "libraries": library_versions(),
    }
    evaluation_units = {
        "holdout_test": "window (linha do CSV; ~1 s; janelas vizinhas são autocorrelacionadas)",
        "cv_train_subjects": "window, out-of-fold agrupado por sujeito",
        "holdout_test_clip_level": "clip (video_id, label)",
    }
    (out_dir / "model_card.json").write_text(json.dumps(card, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "metrics.json").write_text(json.dumps(
        {"evaluation_units": evaluation_units, "cv_train_subjects": cv, "holdout_test": test,
         "holdout_test_clip_level": clip_test}, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "experiment.json").write_text(json.dumps({
        "model_version": version, "created_at": created, "dataset": card["dataset"], "seed": seed,
        "config": {"test_size": test_size, "cv_folds": folds, "threshold": DEFAULT_THRESHOLD,
                   "candidates": sorted(cv), "selected": best,
                   "selection_metric": "PR-AUC (CV agrupado por sujeito)"},
        "split": split, "features": FEATURE_ORDER, "schema_hash": SCHEMA_HASH,
        "reproduce": "mesmo CSV (sha256 acima) + mesma seed/config + mesmas versões de libraries "
                     "=> mesmos bytes do ONNX (verificado em ml/tests/test_train_pipeline.py)",
        "libraries": card["libraries"]}, indent=2, ensure_ascii=False), encoding="utf-8")
    write_confusion_matrix_csv(out_dir / "confusion_matrix.csv", test)
    return {"card": card, "cv": cv, "test": test, "clip_test": clip_test}


def main() -> None:
    p = argparse.ArgumentParser(description="Treina/avalia/exporta o classificador (split por pessoa)")
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--test-size", type=float, default=0.25)
    p.add_argument("--cv-folds", type=int, default=5)
    p.add_argument("--dataset-name", default="não informado", help="ex.: 'UTA-RLDD (0/10)'; vai para o relatório")
    p.add_argument("--deploy", type=Path, default=None,
                   help="copia drowsiness.onnx + model_card.json para esta pasta (ex.: frontend/public/models)")
    a = p.parse_args()

    res = train(a.data, a.out_dir, a.seed, a.test_size, a.cv_folds, a.dataset_name)
    t = res["test"]
    print(f"modelo: {res['card']['model']}  | teste (sujeitos nunca vistos; unidade = JANELA, n={t['n']}):")
    print(f"  recall(DROWSY)={t['drowsy']['recall_sensitivity']}  precisão={t['drowsy']['precision']}  "
          f"especificidade={t['alert']['recall_specificity']}  F1={t['drowsy']['f1']}  "
          f"ROC-AUC={t['roc_auc']}  PR-AUC={t['pr_auc']}")
    print(f"  matriz [[tn,fp],[fn,tp]] = {t['confusion_matrix']['rows_true_cols_pred']}")
    ct = res["clip_test"]
    print("  por clipe:", ct["metrics"]["confusion_matrix"]["rows_true_cols_pred"] if ct["available"]
          else f"indisponível ({ct['reason']})")
    if a.deploy:
        a.deploy.mkdir(parents=True, exist_ok=True)
        shutil.copy2(a.out_dir / "drowsiness.onnx", a.deploy / "drowsiness.onnx")
        shutil.copy2(a.out_dir / "model_card.json", a.deploy / "drowsiness.model-card.json")
        print(f"[deploy] copiado para {a.deploy}")


if __name__ == "__main__":
    main()
