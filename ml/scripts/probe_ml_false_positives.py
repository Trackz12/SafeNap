# -*- coding: utf-8 -*-
"""Sonda o ONNX embarcado com estados ACORDADOS nas escalas REAIS do frontend.

Pergunta que este script responde: o modelo experimental pode ATRAPALHAR a
deteccao, em vez de ajudar?

Por que ele existe: o ONNX foi gerado a partir de faixas escritas a mao
(`generate_realistic_model.py`), e algumas dessas faixas NAO correspondem a
escala que o frontend produz de verdade. O caso mais grave e o `noseDropRatio`:
o gerador usa 0.0-0.08 para "alerta", mas o frontend calibrado opera em torno de
0.30 (ver detectionEngine.scenarios.test.ts). Alem disso, as features do ML usam
EAR ABSOLUTO, enquanto as regras usam EAR RELATIVO ao limiar calibrado da pessoa
-- ou seja, a calibracao, que e a defesa central do projeto contra variacao
entre pessoas, NAO protege o caminho de ML.

O que e medido: para cada estado acordado da grade, P(drowsy) do modelo, contra
os tres limiares que importam em frontend/src/ml/thresholds.ts:
  >= 0.70  inicio da rampa: passa a somar no score continuo de fusao
  >= 0.85  ML_WARNING_THRESHOLD: gera ML_WARNING SOZINHO, sem regra fisiologica
  >= 0.95  ML_ALARM_THRESHOLD: nivel de ML_ALARM (que ainda exige corroboracao)

Definicao ESTRITA de "acordado", para o resultado nao ser contaminado por
estados que ja sao sonolencia:
  perclos   <= 0.08   quase nenhum tempo de olho fechado na janela
  earTrend  >= -0.01  sem declinio progressivo de palpebra
  earStdDev <= 0.035  EAR estavel (sem oscilacao de fechamento)
O EAR ABSOLUTO varia livre de proposito: e a hipotese sob teste.

Uso:  python scripts/probe_ml_false_positives.py
Saida: reports/ml_probe/{awake_probe.json,awake_probe.md}
"""

import itertools
import json
import sys
from pathlib import Path

import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    sys.stderr.write("pip install onnxruntime\n")
    sys.exit(1)

REPO = Path(__file__).resolve().parents[2]
MODEL = REPO / "frontend/public/models/drowsiness.onnx"
SCHEMA = REPO / "shared/feature_schema.json"
OUT_DIR = REPO / "reports/ml_probe"

RAMP_START = 0.70
WARN = 0.85
ALARM = 0.95

ORDER = json.loads(SCHEMA.read_text(encoding="utf-8"))["features"]
IDX = {name: i for i, name in enumerate(ORDER)}

# Grade de estados acordados plausiveis. Escalas conferidas contra os cenarios
# de teste reais do frontend, nao inventadas aqui.
GRID = dict(
    ear=[0.13, 0.16, 0.20, 0.24, 0.28, 0.35],
    mouth=[0.15, 0.30, 0.60],
    nose=[0.25, 0.30, 0.40, 0.50],
    blink=[6, 12, 18, 24],
    perclos=[0.0, 0.04, 0.08],
    std=[0.01, 0.02, 0.035],
    trend=[0.0, -0.01],
    msb=[1000, 4000],
    yaw=[0.02, 0.30],
)


def build(ear, mouth, nose, blink, perclos, std, trend, msb, yaw):
    v = np.zeros(len(ORDER), dtype=np.float32)
    for k in ("ear", "earL", "earR"):
        v[IDX[k]] = ear
    v[IDX["mouthAspect"]] = mouth
    v[IDX["noseDropRatio"]] = nose
    v[IDX["yawRatio"]] = yaw
    v[IDX["earMean"]] = ear
    v[IDX["earStdDev"]] = std
    v[IDX["earMin"]] = max(0.0, ear - 0.02)
    v[IDX["earMax"]] = ear + 0.02
    v[IDX["earTrendPerSec"]] = trend
    v[IDX["blinkRate"]] = blink
    v[IDX["msSinceLastBlink"]] = msb
    v[IDX["perclos"]] = perclos
    v[IDX["mouthMean"]] = mouth
    v[IDX["mouthMax"]] = mouth + 0.02
    v[IDX["mouthTrendPerSec"]] = 0.0
    v[IDX["noseDropMean"]] = nose
    return v


CAVEAT = (
    "Grade sintetica de estados plausiveis, NAO uma amostra de pessoas reais. "
    "Mede a resposta do modelo a vetores nas escalas que o frontend produz; "
    "nao mede a prevalencia desses estados na populacao."
)


def main() -> None:
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name

    def score(vec):
        probs = sess.run(None, {inp: np.array([vec], dtype=np.float32)})[1][0]
        return float(probs[1]) if not isinstance(probs, dict) else float(probs[1])

    rows = []
    for combo in itertools.product(*GRID.values()):
        rows.append({
            "params": dict(zip(GRID.keys(), combo)),
            "p_drowsy": score(build(*combo)),
        })

    total = len(rows)
    n_ramp = sum(1 for r in rows if r["p_drowsy"] >= RAMP_START)
    n_warn = sum(1 for r in rows if r["p_drowsy"] >= WARN)
    n_alarm = sum(1 for r in rows if r["p_drowsy"] >= ALARM)
    worst = max(rows, key=lambda r: r["p_drowsy"])

    isolation = []
    for ear in [0.35, 0.30, 0.24, 0.20, 0.18, 0.16, 0.14, 0.12]:
        isolation.append({
            "ear": ear,
            "p_drowsy": score(build(ear, 0.20, 0.30, 16, 0.02, 0.012, 0.0, 2000, 0.02)),
        })

    report = {
        "question": "O ONNX experimental pode atrapalhar a deteccao?",
        "model": str(MODEL.relative_to(REPO)).replace("\\", "/"),
        "thresholds": {"rampStart": RAMP_START, "mlWarning": WARN, "mlAlarm": ALARM},
        "awakeDefinition": {"perclosMax": 0.08, "earTrendMin": -0.01, "earStdDevMax": 0.035},
        "totalAwakeStates": total,
        "atOrAboveRampStart": {"count": n_ramp, "fraction": n_ramp / total},
        "atOrAboveMlWarning": {"count": n_warn, "fraction": n_warn / total},
        "atOrAboveMlAlarm": {"count": n_alarm, "fraction": n_alarm / total},
        "worstAwakeCase": worst,
        "absoluteEarIsolation": isolation,
        "caveat": CAVEAT,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "awake_probe.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    md = []
    md.append("# Sonda: o ML experimental pode atrapalhar a deteccao?")
    md.append("")
    md.append(CAVEAT)
    md.append("")
    md.append("Modelo: `" + report["model"] + "`  ·  estados acordados avaliados: **" + str(total) + "**")
    md.append("")
    md.append("Definicao ESTRITA de acordado, para nao contaminar o resultado com estados que ja sao")
    md.append("sonolencia: `perclos <= 0.08`, `earTrendPerSec >= -0.01`, `earStdDev <= 0.035`.")
    md.append("O EAR **absoluto** varia livre de proposito — e a hipotese sob teste.")
    md.append("")
    md.append("| Limiar | O que acontece ao cruzar | Estados acordados que cruzam |")
    md.append("|---|---|---|")
    md.append("| `>= 0.70` | passa a somar no score continuo de fusao | **{}** ({:.1f}%) |".format(
        n_ramp, 100 * n_ramp / total))
    md.append("| `>= 0.85` | gera `ML_WARNING` **sozinho**, sem regra fisiologica | **{}** ({:.1f}%) |".format(
        n_warn, 100 * n_warn / total))
    md.append("| `>= 0.95` | nivel de `ML_ALARM` (ainda exige corroboracao) | **{}** ({:.1f}%) |".format(
        n_alarm, 100 * n_alarm / total))
    md.append("")
    md.append("Pior caso acordado: **P(drowsy) = {:.3f}** com ".format(worst["p_drowsy"])
              + ", ".join("`{}={}`".format(k, v) for k, v in worst["params"].items()))
    md.append("")
    md.append("## Isolando o EAR absoluto")
    md.append("")
    md.append("Resto canonicamente acordado (`nose=0.30`, `blink=16`, `perclos=0.02`).")
    md.append("As REGRAS comparam o EAR ao limiar calibrado da pessoa; o ML ve o valor absoluto.")
    md.append("")
    md.append("| EAR absoluto | P(drowsy) |")
    md.append("|---|---|")
    for row in isolation:
        if row["p_drowsy"] >= WARN:
            mark = " ← ML_WARNING sozinho"
        elif row["p_drowsy"] >= RAMP_START:
            mark = " ← soma na fusao"
        else:
            mark = ""
        md.append("| {:.2f} | {:.3f}{} |".format(row["ear"], row["p_drowsy"], mark))
    md.append("")
    (OUT_DIR / "awake_probe.md").write_text("\n".join(md), encoding="utf-8")

    print("estados acordados: {}".format(total))
    print("  >= {} (soma na fusao):   {} ({:.1f}%)".format(RAMP_START, n_ramp, 100 * n_ramp / total))
    print("  >= {} (ML_WARNING so):   {} ({:.1f}%)".format(WARN, n_warn, 100 * n_warn / total))
    print("  >= {} (nivel ML_ALARM):  {} ({:.1f}%)".format(ALARM, n_alarm, 100 * n_alarm / total))
    print("  pior caso acordado: P={:.3f}".format(worst["p_drowsy"]))
    print("[ok] {}".format(OUT_DIR))


if __name__ == "__main__":
    main()
