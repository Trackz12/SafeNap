"""Métricas de classificação binária (classe positiva = 1 = DROWSY).

Tudo que o relatório do TCC cita vem daqui, calculado das contagens da matriz de
confusão (transparente) — exceto ROC-AUC/PR-AUC, que usam scikit-learn.

Leitura para um sistema de segurança:
  - recall/sensibilidade (classe DROWSY): dos momentos realmente sonolentos, quantos
    foram detectados. Falso negativo = sonolência não detectada.
  - especificidade: dos momentos alertas, quantos NÃO geraram alerta. Falso positivo
    = alarme falso (fadiga de alarme, perda de confiança do condutor).
  - precisão: dos alertas emitidos, quantos eram sonolência real. Depende da
    prevalência de DROWSY no conjunto de teste, então NÃO é comparável entre datasets.
  - acurácia isolada engana com classes desbalanceadas; por isso nunca é reportada sozinha.
Nenhuma métrica offline aqui autoriza dizer que o sistema "é seguro".
"""

from typing import Dict, Optional, Sequence

import numpy as np


def _ratio(num: float, den: float) -> Optional[float]:
    return None if den == 0 else num / den


def confusion_counts(y_true: Sequence[int], y_pred: Sequence[int]) -> Dict[str, int]:
    t = np.asarray(y_true).astype(int)
    p = np.asarray(y_pred).astype(int)
    return {
        "tp": int(np.sum((t == 1) & (p == 1))),
        "fp": int(np.sum((t == 0) & (p == 1))),
        "tn": int(np.sum((t == 0) & (p == 0))),
        "fn": int(np.sum((t == 1) & (p == 0))),
    }


def binary_metrics(y_true: Sequence[int], y_pred: Sequence[int],
                   y_score: Optional[Sequence[float]] = None) -> Dict[str, object]:
    c = confusion_counts(y_true, y_pred)
    tp, fp, tn, fn = c["tp"], c["fp"], c["tn"], c["fn"]
    n = tp + fp + tn + fn

    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)              # = sensibilidade
    specificity = _ratio(tn, tn + fp)
    f1 = None if precision is None or recall is None or (precision + recall) == 0 \
        else 2 * precision * recall / (precision + recall)
    balanced = None if recall is None or specificity is None else (recall + specificity) / 2

    out: Dict[str, object] = {
        "n": n,
        "support": {"alert(0)": tn + fp, "drowsy(1)": tp + fn},
        "confusion_matrix": {"labels": ["alert(0)", "drowsy(1)"], "rows_true_cols_pred": [[tn, fp], [fn, tp]], **c},
        "accuracy": _ratio(tp + tn, n),
        "balanced_accuracy": balanced,
        "drowsy": {"precision": precision, "recall_sensitivity": recall, "f1": f1,
                   "false_negative_rate": _ratio(fn, tp + fn)},
        "alert": {"precision_npv": _ratio(tn, tn + fn), "recall_specificity": specificity,
                  "false_positive_rate": _ratio(fp, tn + fp)},
        "roc_auc": None,
        "pr_auc": None,
    }

    both = len(set(np.asarray(y_true).astype(int).tolist())) == 2
    if y_score is not None and both:
        from sklearn.metrics import average_precision_score, roc_auc_score
        out["roc_auc"] = float(roc_auc_score(y_true, y_score))
        out["pr_auc"] = float(average_precision_score(y_true, y_score))
    return out
