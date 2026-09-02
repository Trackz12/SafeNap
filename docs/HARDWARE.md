# Integração de Hardware

O SAFENAP Web interage com um Arduino Nano via porta Serial USB, controlado de maneira isolada pelo `SerialManager` no Backend Python.

## Pinagem no Arduino Nano
O código atual (`safenap.ino`) espera:
- **Pino 8:** Buzzer Piezoelétrico.
- **Pino 9:** Módulo de Motor de Vibração.
- **Pino 13:** LED embutido da placa (usado para feedback visual de que o alarme ativou).

## Comandos Seriais
Todas as strings enviadas do Python para o Arduino são terminadas com `\n`.
O Arduino processa as strings completas (ignorando espaços ou quebras) e responde um "OK".

| Comando TX (Python -> Arduino) | Ação no Arduino | Resposta RX (Arduino -> Python) |
|---------------------------------|-----------------|----------------------------------|
| `ALARM_ON`                      | Liga Buzzer, Motor e LED (ALTA intensidade) | `OK:ALARM_ON` |
| `ALARM_OFF`                     | Desliga tudo | `OK:ALARM_OFF` |
| `VIBRATION_ON`                  | Liga apenas Motor e LED (Aviso leve) | `OK:VIBRATION_ON` |
| `VIBRATION_OFF`                 | Desliga Motor e LED | `OK:VIBRATION_OFF` |
| `STATUS`                        | Apenas verifica se a placa respira | `OK:STATUS_ONLINE` |

Qualquer outro comando gera `ERR:UNKNOWN_COMMAND_[cmd]`.

## Autodetecção (Python)
O backend usa a biblioteca `pyserial` para escanear a lista de `COMx` ativas. Ele tenta conectar na primeira porta que possuir "Arduino" ou "CH340" no descritivo (drivers comuns de clonados e originais).

## Health Check (detecção de Arduino travado)

Enquanto conectado, o backend faz **ping periódico** do comando `STATUS` (a cada 10s). Toda resposta válida do Arduino (`OK:*` ou `SAFENAP_READY`) renova o registro de vida.

- **Arduino saudável**: responde ao ping → `is_responsive() = true`.
- **Arduino travado** (conectado fisicamente mas sem firmware/loop): silêncio por mais de **35s** → o pinger **derruba a conexão** para acionar a reconexão automática (que pode até reconectar na mesma porta se o firmware voltar).
- **Exposição**:
  - `/api/status` → `serial_responsive: bool` + `serial_last_response_age_s`
  - Evento WS `HARDWARE_STATUS` → payload `{ connected, responsive }` (broadcast em cada mudança de conexão)
  - UI: badge no header — verde "Arduino" (saudável), amarelo "Travado" (conectado sem responder), cinza (desconectado).

> Nota: firmware antigo sem suporte a `STATUS` também fica "travado" para o health check — atualize o sketch (`arduino/safenap/safenap.ino`) que já responde `OK:STATUS_ONLINE`.
