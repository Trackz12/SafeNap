# Latência de processamento do backend (medida)

time.perf_counter() em torno de cada chamada; N=2000 iteracoes uteis apos 50 de warmup descartadas; SerialManager mockado (sem I/O real de hardware); Python 3.14.6; medido em win32.

| Operação | N | média (µs) | mediana (µs) | p95 (µs) | p99 (µs) |
|---|---|---|---|---|---|
| `SafetyManager.process_event` | 2000 | 94.4 | 97.4 | 126.4 | 190.9 |
| `GripMonitor.update` | 2000 | 0.45 | 0.4 | 0.5 | 0.5 |

Não incluído aqui (ver `reports/latency/`): extração de landmarks no navegador, 
cálculo de regras no frontend, viagem de rede do WebSocket, transmissão serial física.
