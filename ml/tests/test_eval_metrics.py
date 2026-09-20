import pytest

from evaluation.metrics import binary_metrics, confusion_counts


def test_confusion_and_rates_by_hand():
    y = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0]
    p = [1, 1, 1, 0, 0, 0, 0, 0, 1, 1]
    assert confusion_counts(y, p) == {"tp": 3, "fn": 1, "tn": 4, "fp": 2}
    m = binary_metrics(y, p)
    assert m["accuracy"] == pytest.approx(7 / 10)
    assert m["drowsy"]["precision"] == pytest.approx(3 / 5)
    assert m["drowsy"]["recall_sensitivity"] == pytest.approx(3 / 4)
    assert m["alert"]["recall_specificity"] == pytest.approx(4 / 6)
    assert m["drowsy"]["f1"] == pytest.approx(2 * 0.6 * 0.75 / (0.6 + 0.75))
    assert m["drowsy"]["false_negative_rate"] == pytest.approx(1 / 4)
    assert m["alert"]["false_positive_rate"] == pytest.approx(2 / 6)
    assert m["confusion_matrix"]["rows_true_cols_pred"] == [[4, 2], [1, 3]]
    assert m["balanced_accuracy"] == pytest.approx((0.75 + 4 / 6) / 2)


def test_auc_perfect_and_undefined_cases():
    m = binary_metrics([0, 0, 1, 1], [0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])
    assert m["roc_auc"] == 1.0 and m["pr_auc"] == 1.0
    only_neg = binary_metrics([0, 0, 0], [0, 0, 0], [0.1, 0.2, 0.3])
    assert only_neg["drowsy"]["recall_sensitivity"] is None  # sem positivos: indefinido, não 0
    assert only_neg["roc_auc"] is None


def test_accuracy_alone_would_mislead_on_imbalance():
    y = [0] * 95 + [1] * 5
    m = binary_metrics(y, [0] * 100)  # nunca detecta sonolência
    assert m["accuracy"] == 0.95 and m["drowsy"]["recall_sensitivity"] == 0.0
