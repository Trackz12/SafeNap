"""Bateria de cenários sintéticos do SafetyManager — sistema integrado
(visão + FSR fundidos em OR por severidade).

Complementa as baterias isoladas de visão
(frontend/src/detection/detectionEngine.scenarios.test.ts) e de garra
(backend/tests/test_grip_monitor_scenarios.py): aqui o que se testa é
especificamente a FUSÃO entre as duas fontes de sinal — a garantia central
do artigo (nenhuma fonte consegue apagar um alarme ativo da outra).

Gera reports/fusion_scenarios/scenarios.{json,md}.
"""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.protocol import EventType, SafetyState, WebSocketMessage
from app.safety.manager import SafetyManager


def vision_event(event_type: EventType) -> WebSocketMessage:
    return WebSocketMessage(type=event_type, timestamp=0.0, session_id="fusion-scenarios")


_results: list[dict] = []


def record(name: str, description: str, ground_truth: SafetyState, manager: SafetyManager) -> None:
    predicted = manager.current_state
    _results.append({
        "name": name,
        "description": description,
        "ground_truth": ground_truth.value,
        "predicted": predicted.value,
        "correct": predicted == ground_truth,
    })
    assert predicted == ground_truth, f"{name}: esperado {ground_truth}, obtido {predicted}"


@pytest.fixture()
def manager():
    with patch("app.safety.manager.serial_manager"):
        yield SafetyManager()


def test_ambos_normais(manager):
    record("ambos_normais", "Nenhuma fonte ativa", SafetyState.NORMAL, manager)


def test_apenas_visao_alarme(manager):
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    record("apenas_visao_alarme", "Só a visão dispara ALARM", SafetyState.ALARM, manager)


def test_apenas_garra_alarme(manager):
    manager.process_grip_signal(SafetyState.ALARM)
    record("apenas_garra_alarme", "Só a garra (FSR) dispara ALARM", SafetyState.ALARM, manager)


def test_apenas_visao_aviso(manager):
    manager.process_event(vision_event(EventType.DROWSINESS_WARNING))
    record("apenas_visao_aviso", "Só a visão dispara WARNING", SafetyState.WARNING, manager)


def test_apenas_garra_aviso(manager):
    manager.process_grip_signal(SafetyState.WARNING)
    record("apenas_garra_aviso", "Só a garra dispara WARNING", SafetyState.WARNING, manager)


def test_visao_alarme_domina_garra_aviso(manager):
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    manager.process_grip_signal(SafetyState.WARNING)
    record("visao_alarme_domina", "Visão ALARM + garra WARNING -> ALARM (mais severo vence)", SafetyState.ALARM, manager)


def test_visao_alarme_sobrevive_garra_normalizando(manager):
    """Regressão central da fusão: mão volta ao volante não pode apagar
    um alarme real de sonolência ocular."""
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    manager.process_grip_signal(SafetyState.WARNING)
    manager.process_grip_signal(SafetyState.NORMAL)
    record("visao_sobrevive_garra_normaliza", "Garra normaliza mas visão ALARM persiste", SafetyState.ALARM, manager)


def test_garra_alarme_sobrevive_visao_terminando(manager):
    """Simétrico: olhos reabrirem não pode apagar um alarme real de mão
    fora do volante."""
    manager.process_grip_signal(SafetyState.ALARM)
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    manager.process_event(vision_event(EventType.DROWSINESS_ENDED))
    record("garra_sobrevive_visao_termina", "Visão termina mas garra ALARM persiste", SafetyState.ALARM, manager)


def test_ack_zera_as_duas_fontes(manager):
    manager.process_grip_signal(SafetyState.ALARM)
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    manager.process_event(vision_event(EventType.ALARM_ACKNOWLEDGED))
    record("ack_zera_ambas", "ALARM_ACKNOWLEDGED zera visão e garra juntas", SafetyState.NORMAL, manager)


def test_estado_so_cai_quando_as_duas_fontes_liberam(manager):
    manager.process_event(vision_event(EventType.DROWSINESS_WARNING))
    manager.process_grip_signal(SafetyState.WARNING)
    manager.process_event(vision_event(EventType.DROWSINESS_WARNING_ENDED))
    # garra ainda em WARNING -> estado nao deve cair ainda
    assert manager.current_state == SafetyState.WARNING
    manager.process_grip_signal(SafetyState.NORMAL)
    record("cai_so_com_ambas_liberadas", "Estado só cai a NORMAL quando ambas as fontes liberam", SafetyState.NORMAL, manager)


def test_desconexao_total_zera_tudo(manager):
    manager.process_event(vision_event(EventType.DROWSINESS_STARTED))
    manager.process_grip_signal(SafetyState.ALARM)
    manager.on_all_clients_disconnected()
    record("desconexao_total", "Última desconexão zera as duas fontes (fail-safe)", SafetyState.NORMAL, manager)


def test_write_report():
    out_dir = Path(__file__).resolve().parent.parent.parent / "reports" / "fusion_scenarios"
    out_dir.mkdir(parents=True, exist_ok=True)

    total = len(_results)
    correct = sum(1 for r in _results if r["correct"])

    is_alert = lambda s: s != SafetyState.NORMAL.value  # noqa: E731
    tp = fp = tn = fn = 0
    for r in _results:
        gt, pred = is_alert(r["ground_truth"]), is_alert(r["predicted"])
        if gt and pred:
            tp += 1
        elif not gt and pred:
            fp += 1
        elif not gt and not pred:
            tn += 1
        else:
            fn += 1
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    report = {
        "methodology": (
            "Cenarios sinteticos executados contra o SafetyManager real, "
            "combinando eventos de visao (self-declared pelo frontend) e "
            "sinais de garra (GripMonitor) para verificar especificamente a "
            "garantia central da fusao OR por severidade: nenhuma fonte "
            "consegue suprimir um alarme ativo originado pela outra. "
            "Verificacao de especificacao, nao validacao com condutores "
            "reais em condicao dinamica de direcao."
        ),
        "total_scenarios": total,
        "correct": correct,
        "confusion_matrix_binary": {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": precision, "recall": recall, "f1": f1},
        "scenarios": _results,
    }
    with open(out_dir / "scenarios.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    md = [
        "# Bateria de cenários sintéticos — SafetyManager (sistema integrado, visão + FSR)",
        "",
        report["methodology"],
        "",
        f"**{correct}/{total}** cenários classificados conforme a verdade-fundamental atribuída.",
        "",
        "## Matriz de confusão (binária: alerta = WARNING ou ALARM vs. sem alerta = NORMAL)",
        "",
        "| | Previsto: alerta | Previsto: sem alerta |",
        "|---|---|---|",
        f"| **Real: alerta** | VP={tp} | FN={fn} |",
        f"| **Real: sem alerta** | FP={fp} | VN={tn} |",
        "",
        f"Precisão: **{precision:.3f}** · Recall: **{recall:.3f}** · F1: **{f1:.3f}**",
        "",
        "## Cenários individuais",
        "",
        "| Cenário | Descrição | Verdade | Previsto | OK |",
        "|---|---|---|---|---|",
    ]
    for r in _results:
        md.append(f"| {r['name']} | {r['description']} | {r['ground_truth']} | {r['predicted']} | {'✅' if r['correct'] else '❌'} |")
    with open(out_dir / "scenarios.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
