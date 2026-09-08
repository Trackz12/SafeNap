"""Mede a latencia REAL de ida-e-volta do WebSocket, com o backend rodando
de verdade (uvicorn, processo separado) -- nao um mock, nao uma estimativa.

O SafetyManager nao manda ACK para SAFETY_EVENTS ("o backend e um sink"),
entao nao ha resposta direta pra medir round-trip nesses. Usamos
DETECTOR_CLAIM -> DETECTOR_ASSIGNED (que tem resposta explicita) como
sinal: o custo de rede + parsing JSON + dispatch do asyncio e o mesmo,
independente do tipo de evento.

Importante: isso mede localhost (loopback), sem hardware fisico do outro
lado e sem a rede real de um veiculo (Tailscale/Wi-Fi) -- e um piso, nao o
pior caso.

Uso:
    cd backend && .venv/Scripts/python.exe scripts/measure_ws_roundtrip.py
"""

import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    sys.exit("pip install websockets")

import asyncio

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PORT = 8123
WS_URL = f"ws://127.0.0.1:{PORT}/ws"
N_ITERATIONS = 200
N_WARMUP = 10


async def run_roundtrips() -> list[float]:
    samples_ms: list[float] = []
    async with websockets.connect(WS_URL) as ws:
        await ws.recv()  # STATE_SNAPSHOT inicial

        async def one_claim(session_id: str) -> float:
            msg = {
                "type": "DETECTOR_CLAIM",
                "timestamp": time.time(),
                "session_id": session_id,
                "payload": {},
            }
            t0 = time.perf_counter()
            await ws.send(json.dumps(msg))
            await ws.recv()  # DETECTOR_ASSIGNED
            t1 = time.perf_counter()
            return (t1 - t0) * 1000

        for i in range(N_WARMUP):
            await one_claim(f"warmup-{i}")

        for i in range(N_ITERATIONS):
            samples_ms.append(await one_claim(f"bench-{i}"))

    return samples_ms


def compute_stats(samples_ms: list[float]) -> dict:
    s = sorted(samples_ms)
    n = len(s)
    return {
        "n": n,
        "mean_ms": round(statistics.mean(s), 3),
        "median_ms": round(statistics.median(s), 3),
        "p95_ms": round(s[int(n * 0.95)], 3),
        "p99_ms": round(s[int(n * 0.99)], 3),
        "min_ms": round(s[0], 3),
        "max_ms": round(s[-1], 3),
    }


def wait_for_server(proc: subprocess.Popen, timeout_s: float = 15.0) -> None:
    import socket

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("Servidor uvicorn encerrou antes de subir.")
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise TimeoutError("Servidor uvicorn não respondeu a tempo.")


def main() -> None:
    python_exe = sys.executable
    proc = subprocess.Popen(
        [python_exe, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=str(BACKEND_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(proc)
        samples_ms = asyncio.run(run_roundtrips())
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    stats = compute_stats(samples_ms)
    result = {
        "methodology": (
            f"Backend real (uvicorn, processo separado, porta {PORT}), cliente "
            f"websockets.connect() em loopback (127.0.0.1). Medido: "
            "DETECTOR_CLAIM enviado -> DETECTOR_ASSIGNED recebido (unico evento "
            "com resposta direta; SAFETY_EVENTS nao tem ACK por design). "
            f"N={N_ITERATIONS} apos {N_WARMUP} de warmup. NAO inclui hardware "
            "fisico nem rede real de veiculo (Tailscale/Wi-Fi) -- e loopback local."
        ),
        "ws_claim_roundtrip": stats,
    }

    out_dir = BACKEND_ROOT.parent / "reports" / "latency"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "ws_roundtrip.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    md = [
        "# Latência de ida-e-volta do WebSocket (medida, backend real)",
        "",
        result["methodology"],
        "",
        "| N | média (ms) | mediana (ms) | p95 (ms) | p99 (ms) |",
        "|---|---|---|---|---|",
        f"| {stats['n']} | {stats['mean_ms']} | {stats['median_ms']} | {stats['p95_ms']} | {stats['p99_ms']} |",
    ]
    with open(out_dir / "ws_roundtrip.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
