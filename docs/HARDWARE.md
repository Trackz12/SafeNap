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
