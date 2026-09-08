# Integração de Hardware

O SAFENAP Web interage com um Arduino Nano via porta Serial USB, controlado de maneira isolada pelo `SerialManager` no Backend Python. O Arduino é "burro" por design: só atua (buzzer/vibração/LED) e só lê sensores crus (FSR) — toda interpretação (limiares, calibração, debounce) mora no backend Python (`SafetyManager` / `GripMonitor`).

## Pinagem no Arduino Nano

A pinagem atual (`safenap.ino`) restaura a configuração real usada no
firmware histórico das simulações originais do TCC — **um** sensor FSR-402
(não dois) e **quatro** motores de vibração (não um):

- **Pino 4:** Buzzer Piezoelétrico.
- **Pinos 5, 6, 7, 8:** quatro motores de vibração (acionados juntos).
- **Pino 13:** LED embutido da placa (usado para feedback visual de que o alarme ativou).
- **Pino A0 (entrada analógica):** um sensor de força resistiva FSR-402, montado na empunhadura simulada do volante (segundo sinal de sonolência, fundido em OR com a visão computacional — ver `docs/ARCHITECTURE.md`).

### Circuito do FSR-402 (divisor de tensão)

O FSR fica em série com um resistor fixo de 10kΩ, formando um divisor de tensão entre 5V e GND; o ponto médio vai para o pino analógico A0:

```
5V ── FSR-402 ──┬── A0
                │
               10kΩ
                │
               GND
```

Mais força na empunhadura → menor resistência do FSR → maior tensão no pino
analógico → leitura mais alta em `analogRead()` (0–1023). Uma queda abrupta
na leitura indica que a mão saiu do volante.

## Comandos Seriais
Todas as strings enviadas do Python para o Arduino são terminadas com `\n`.
O Arduino processa as strings completas (ignorando espaços ou quebras) e responde um "OK".

| Comando TX (Python -> Arduino) | Ação no Arduino | Resposta RX (Arduino -> Python) |
|---------------------------------|-----------------|----------------------------------|
| `ALARM_ON`                      | Liga Buzzer, os 4 motores e LED (ALTA intensidade) | `OK:ALARM_ON` |
| `ALARM_OFF`                     | Desliga tudo | `OK:ALARM_OFF` |
| `VIBRATION_ON`                  | Liga apenas os 4 motores e LED (Aviso leve) | `OK:VIBRATION_ON` |
| `VIBRATION_OFF`                 | Desliga os motores e LED | `OK:VIBRATION_OFF` |
| `STATUS`                        | Apenas verifica se a placa respira | `OK:STATUS_ONLINE` |

Qualquer outro comando gera `ERR:UNKNOWN_COMMAND_[cmd]`.

## Streaming do sensor de pressão (Arduino -> Python)

Diferente dos comandos acima (requisição/resposta), a leitura do FSR é um
**streaming não solicitado**: a cada ~200ms (`FSR_INTERVAL_MS`, via `millis()`,
sem bloquear o parsing de comandos) o Arduino envia:

```
FSR:<leitura_A0>\n
```

Exemplo: `FSR:612`. O `SerialManager` reconhece o prefixo `FSR:` e repassa
o valor ao `GripMonitor` (`backend/app/safety/grip_monitor.py`), que:

1. Calibra uma **baseline adaptativa** (média móvel exponencial) enquanto a
   garra está OK — congelada durante uma queda, para não "absorver" a própria
   queda como novo normal. Isso substitui o limiar fixo do firmware
   histórico (`fsrLimite = 220`), que exigia recalibrar manualmente para
   cada sensor/instalação.
2. Aplica **histerese**: perde a garra abaixo de 35% da baseline, só recupera
   acima de 60% (evita flicker perto do limiar).
3. Exige queda **sustentada** (debounce): ≥500ms → `WARNING`, ≥1000ms →
   `ALARM` — o limiar de `ALARM` replica a tolerância de 1s do firmware
   histórico (`tempoTolerancia`); o estágio de `WARNING` é um aviso mais
   cedo que o sistema original não tinha.
4. **Sem corte automático do alarme**: o firmware histórico desligava o
   alerta sozinho após 10s (`tempoMaximoAlerta`), mesmo que a mão não
   tivesse voltado ao volante. O `GripMonitor` atual não reproduz esse
   comportamento — o alarme permanece enquanto a queda persistir, e só é
   silenciado por confirmação explícita do usuário (`ALARM_ACKNOWLEDGED`).
5. Alimenta o `SafetyManager` como uma segunda fonte de sinal (independente
   da visão/ML do frontend), fundida em **OR por severidade**: o estado
   efetivo do sistema é sempre o mais grave entre "visão" e "garra".

Qualquer linha `FSR:` recebida também renova o health check do serial
(prova de vida mais forte que o ping `STATUS` a cada 10s).

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
