"""Bateria de cenários sintéticos do GripMonitor (sensor de pressão FSR-402,
isolado — sem visão computacional envolvida).

Mesmo princípio da bateria de detecção visual
(frontend/src/detection/detectionEngine.scenarios.test.ts): cada cenário
representa uma faixa mecânica plausível documentada em docs/HARDWARE.md
(limiares de queda/recuperação, debounce), executado contra o GripMonitor
real com um relógio controlado. Isto verifica que o código implementa
corretamente sua própria especificação — não que os limiares escolhidos
correspondem ao comportamento real de mãos humanas no volante; essa
validação com dados humanos reais permanece como trabalho futuro (não há,
diferente da visão computacional, um dataset público de pressão de
empunhadura veicular rotulado disponível).

Gera reports/grip_scenarios/scenarios.{json,md} como efeito colateral,
além de rodar como parte da suíte normal (pytest).
"""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.protocol import SafetyState
from app.safety.grip_monitor import GripMonitor

BASELINE_PRESSURE = 600.0
DROPPED_PRESSURE = 50.0  # bem abaixo de 35% de 600


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def calibrate(monitor: GripMonitor, clock: FakeClock, pressure: float = BASELINE_PRESSURE) -> None:
    for _ in range(GripMonitor.MIN_BASELINE_SAMPLES + 1):
        monitor.update(pressure)
        clock.advance(0.2)


_results: list[dict] = []


def record(name: str, description: str, ground_truth: SafetyState, monitor: GripMonitor) -> None:
    predicted = monitor.status()["state"]
    _results.append({
        "name": name,
        "description": description,
        "ground_truth": ground_truth.value,
        "predicted": predicted.value,
        "correct": predicted == ground_truth,
    })
    assert predicted == ground_truth, f"{name}: esperado {ground_truth}, obtido {predicted}"


@pytest.fixture(autouse=True)
def _mock_safety_manager():
    with patch("app.safety.grip_monitor.safety_manager"):
        yield


def test_pressao_estavel_normal():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(BASELINE_PRESSURE)
    record("pressao_estavel", "Pressão constante na baseline", SafetyState.NORMAL, monitor)


def test_queda_breve_300ms():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(0.3)
    monitor.update(DROPPED_PRESSURE)
    record("queda_breve_300ms", "Queda de pressão por 300ms (< WARNING_MS=500ms)", SafetyState.NORMAL, monitor)


def test_queda_sustentada_600ms():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(0.6)
    monitor.update(DROPPED_PRESSURE)
    record("queda_sustentada_600ms", "Queda de pressão por 600ms (> WARNING_MS=500ms)", SafetyState.WARNING, monitor)


def test_queda_sustentada_1200ms():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(1.2)
    monitor.update(DROPPED_PRESSURE)
    record("queda_sustentada_1200ms", "Queda de pressão por 1200ms (> ALARM_MS=1000ms)", SafetyState.ALARM, monitor)


def test_recuperacao_apos_alarme():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(1.2)
    monitor.update(DROPPED_PRESSURE)
    assert monitor.status()["state"] == SafetyState.ALARM  # pré-condição
    recovered = BASELINE_PRESSURE * 0.65  # acima do RECOVER_RATIO=0.60
    monitor.update(recovered)
    record("recuperacao_apos_alarme", "Pressão volta acima de 60% da baseline após ALARM", SafetyState.NORMAL, monitor)


def test_recuperacao_parcial_nao_libera():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(0.6)
    monitor.update(DROPPED_PRESSURE)
    partial = BASELINE_PRESSURE * 0.45  # entre DROP_RATIO(0.35) e RECOVER_RATIO(0.60)
    monitor.update(partial)
    record(
        "recuperacao_parcial_nao_libera",
        "Pressão sobe mas fica entre 35% e 60% da baseline (histerese não libera)",
        SafetyState.WARNING,
        monitor,
    )


def test_deriva_gradual_da_baseline():
    """Deriva lenta e legítima (ex.: acomodação do sensor) não deve disparar
    alarme, porque a baseline adaptativa acompanha a tendência."""
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    pressure = BASELINE_PRESSURE
    for _ in range(40):
        pressure *= 0.99  # deriva de ~1% por amostra, dentro do que a EMA acompanha
        clock.advance(0.2)
        monitor.update(pressure)
    record("deriva_gradual_baseline", "Deriva lenta de pressão (baseline adaptativa acompanha)", SafetyState.NORMAL, monitor)


def test_sem_calibracao_nao_avalia():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(5.0)
    monitor.update(DROPPED_PRESSURE)
    record("sem_calibracao", "Leitura baixa isolada sem baseline calibrada ainda", SafetyState.NORMAL, monitor)


def test_alarme_sustentado_nao_se_autolibera():
    """Regressão: o alarme deve permanecer mesmo muito além do limiar,
    sem corte automático por tempo (ver docs/HARDWARE.md, item 4)."""
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(30.0)  # bem além dos 10s do firmware histórico
    monitor.update(DROPPED_PRESSURE)
    record("alarme_sustentado_sem_autocorte", "Queda mantida por 30s — sem corte automático", SafetyState.ALARM, monitor)


def test_reset_apos_reconexao_volta_a_normal():
    clock = FakeClock()
    monitor = GripMonitor(clock=clock)
    calibrate(monitor, clock)
    monitor.update(DROPPED_PRESSURE)
    clock.advance(1.2)
    monitor.update(DROPPED_PRESSURE)
    monitor.reset()
    record("reset_apos_reconexao", "Reset (simula queda/reconexão de serial) limpa o estado", SafetyState.NORMAL, monitor)


def test_write_report():
    """Não é um cenário — escreve o relatório consolidado ao final da suíte
    (depende da ordem de coleta do pytest, que roda os testes deste
    arquivo em ordem de definição por padrão)."""
    out_dir = Path(__file__).resolve().parent.parent.parent / "reports" / "grip_scenarios"
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
            "Cenarios sinteticos executados contra o GripMonitor real (nao uma "
            "reimplementacao), com relogio controlado. Verdade-fundamental "
            "atribuida pelos autores com base nos limiares documentados em "
            "docs/HARDWARE.md -- verificacao de especificacao, nao validacao "
            "com dados humanos reais (nao ha dataset publico de pressao de "
            "empunhadura veicular disponivel, diferente da visao computacional)."
        ),
        "total_scenarios": total,
        "correct": correct,
        "confusion_matrix_binary": {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": precision, "recall": recall, "f1": f1},
        "scenarios": _results,
    }
    with open(out_dir / "scenarios.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    md = [
        "# Bateria de cenários sintéticos — GripMonitor (FSR isolado)",
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
