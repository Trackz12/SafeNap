# Transmissão serial USB → Arduino (calculado, não medido)

**Este número é calculado a partir do baud rate configurado, não medido** — não
há hardware físico conectado neste ambiente de desenvolvimento. É um limite
determinístico (a física da UART não varia), mas não substitui uma medição
real em bancada com um Arduino conectado.

## Fórmula

Enquadramento serial padrão usado pelo `pyserial`/Arduino: **8N1** (8 bits de
dado, sem paridade, 1 bit de parada) + 1 bit de start = **10 bits por
caractere** transmitido.

```
tempo_transmissao_ms = (num_caracteres × 10 bits) ÷ baud_rate × 1000
```

Baud rate do SafeNap: **9600 bps** (`backend/app/serial/manager.py`,
`arduino/safenap/safenap.ino`).

## Comandos reais do protocolo

| Comando | Caracteres (com `\n`) | Bits | Tempo calculado |
|---|---|---|---|
| `ALARM_ON\n` | 9 | 90 | **9,4 ms** |
| `ALARM_OFF\n` | 10 | 100 | **10,4 ms** |
| `VIBRATION_ON\n` | 13 | 130 | **13,5 ms** |
| `VIBRATION_OFF\n` | 14 | 140 | **14,6 ms** |
| `STATUS\n` | 7 | 70 | **7,3 ms** |

O comando mais usado em um alarme real (`ALARM_ON`) leva **~9,4 ms** para
sair completamente pela UART a 9600 bps — um limite inferior determinístico
para essa etapa isolada, sem contar buffers do driver USB-serial (CH340/
FTDI) nem o tempo de processamento do `loop()` do Arduino entre bytes.
