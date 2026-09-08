"""Mede a latencia REAL de processamento do backend (nao estimada).

Escopo do que este script mede:
- SafetyManager.process_event(): tempo entre o backend receber um evento
  de seguranca (ja parseado) e terminar de decidir/despachar o comando
  serial (com o SerialManager mockado -- sem I/O real de hardware).
- GripMonitor.update(): tempo de processar uma leitura crua do FSR.

O que este script NAO mede (fica em outros relatorios, ver reports/latency/):
- Extracao de landmarks pelo MediaPipe (roda no navegador do usuario, fora
  do nosso codigo, e depende do hardware/browser dele).
- Calculo de EAR/PERCLOS/regras no frontend (medido separadamente via
  `vitest bench`, ver frontend/src/detection/detectionEngine.bench.ts).
- Viagem de rede do WebSocket navegador -> backend (medido separadamente
  via scripts/measure_ws_roundtrip.py, com o backend real rodando).
- Transmissao serial fisica USB -> Arduino (nao medida: nao ha hardware
  fisico neste ambiente; um limite calculado a partir do baud rate esta em
  reports/latency/serial_transmission_calc.md).

Uso:
    cd backend && .venv/Scripts/python.exe scripts/measure_latency.py
"""

import json
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.core.protocol import EventType, WebSocketMessage  # noqa: E402
from app.safety.grip_monitor import GripMonitor  # noqa: E402
from app.safety.manager import SafetyManager  # noqa: E402

N_ITERATIONS = 2000
N_WARMUP = 50


def _event(event_type: EventType) -> WebSocketMessage:
    return WebSocketMessage(type=event_type, timestamp=0.0, session_id="latency-bench")


def measure_safety_manager_process_event() -> list[float]:
    """Ciclo ALARM->NORMAL repetido: cada ciclo aplica hardware 2x (liga/desliga)."""
    with patch("app.safety.manager.serial_manager"):
        manager = SafetyManager()
        for _ in range(N_WARMUP):
            manager.process_event(_event(EventType.DROWSINESS_STARTED))
            manager.process_event(_event(EventType.DROWSINESS_ENDED))

        samples_us: list[float] = []
        for _ in range(N_ITERATIONS):
            t0 = time.perf_counter()
            manager.process_event(_event(EventType.DROWSINESS_STARTED))
            t1 = time.perf_counter()
            samples_us.append((t1 - t0) * 1_000_000)
            manager.process_event(_event(EventType.DROWSINESS_ENDED))
    return samples_us


def measure_grip_monitor_update() -> list[float]:
    with patch("app.safety.grip_monitor.safety_manager"):
        monitor = GripMonitor(clock=time.monotonic)
        for _ in range(GripMonitor.MIN_BASELINE_SAMPLES + N_WARMUP):
            monitor.update(600.0)

        samples_us: list[float] = []
        for i in range(N_ITERATIONS):
            pressure = 600.0 + (i % 5)  # pequena variacao, sem cruzar limiares
            t0 = time.perf_counter()
            monitor.update(pressure)
            t1 = time.perf_counter()
            samples_us.append((t1 - t0) * 1_000_000)
    return samples_us


def compute_stats(samples_us: list[float]) -> dict:
    s = sorted(samples_us)
    n = len(s)
    return {
        "n": n,
        "mean_us": round(statistics.mean(s), 2),
        "median_us": round(statistics.median(s), 2),
        "p95_us": round(s[int(n * 0.95)], 2),
        "p99_us": round(s[int(n * 0.99)], 2),
        "min_us": round(s[0], 2),
        "max_us": round(s[-1], 2),
    }


def main() -> None:
    sm_stats = compute_stats(measure_safety_manager_process_event())
    gm_stats = compute_stats(measure_grip_monitor_update())

    result = {
        "methodology": (
            f"time.perf_counter() em torno de cada chamada; N={N_ITERATIONS} "
            f"iteracoes uteis apos {N_WARMUP} de warmup descartadas; "
            "SerialManager mockado (sem I/O real de hardware); "
            "Python {}; medido em {}."
        ).format(sys.version.split()[0], sys.platform),
        "safety_manager_process_event": sm_stats,
        "grip_monitor_update": gm_stats,
    }

    out_dir = BACKEND_ROOT.parent / "reports" / "latency"
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(out_dir / "backend_processing.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    md = [
        "# Latência de processamento do backend (medida)",
        "",
        result["methodology"],
        "",
        "| Operação | N | média (µs) | mediana (µs) | p95 (µs) | p99 (µs) |",
        "|---|---|---|---|---|---|",
        (
            f"| `SafetyManager.process_event` | {sm_stats['n']} | {sm_stats['mean_us']} | "
            f"{sm_stats['median_us']} | {sm_stats['p95_us']} | {sm_stats['p99_us']} |"
        ),
        (
            f"| `GripMonitor.update` | {gm_stats['n']} | {gm_stats['mean_us']} | "
            f"{gm_stats['median_us']} | {gm_stats['p95_us']} | {gm_stats['p99_us']} |"
        ),
        "",
        "Não incluído aqui (ver `reports/latency/`): extração de landmarks no navegador, ",
        "cálculo de regras no frontend, viagem de rede do WebSocket, transmissão serial física.",
    ]
    with open(out_dir / "backend_processing.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
