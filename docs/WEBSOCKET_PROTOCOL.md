# Protocolo WebSocket

A comunicação em tempo real entre o Frontend e o Backend ocorre via WebSocket (`ws://localhost:8000/ws`, ou via origem HTTPS do túnel: `wss://<host>/ws`).

## Formato da Mensagem

Todas as mensagens enviadas pelo Frontend devem seguir o formato JSON abaixo:

```json
{
  "type": "DROWSINESS_STARTED",
  "timestamp": 1692223445.123,
  "session_id": "rand123",
  "payload": {
    "reason": "EYES_CLOSED_DURATION",
    "perclos": 0.32,
    "closedForMs": 1600
  }
}
```

## Tipos de Eventos (EventTypes)

### Sinais brutos de detecção (frontend → backend, informativos)

| Evento | Descrição |
|--------|-----------|
| `FACE_DETECTED` | Rosto (re)encontrado no frame atual pelo MediaPipe. |
| `FACE_LOST` | Rosto sumiu da câmera por tempo acima do limite de aviso. Payload: `lostForMs`. |
| `EYES_OPEN` | Olhos reabriram (EAR acima do limite com histerese). |
| `EYES_CLOSED` | Olhos fecharam (EAR abaixo do limite). |
| `YAWN_DETECTED` | Bocejo detectado (mouth aspect ratio alto por tempo mínimo). Payload: `mouthAspect`. |
| `HEAD_DROPPED` | Cabeça abaixando sustentadamente (queda do nariz além do baseline calibrado). Payload: `noseDropRatio`, `baseline`. |

### Eventos de segurança (frontend → backend, acionam hardware)

| Evento | Descrição | Efeito no hardware |
|--------|-----------|--------------------|
| `DROWSINESS_WARNING` | Entrada no estado `WARNING` (PERCLOS alto, bocejo, cabeça caindo, rosto ausente, fechamento prolongado OU score ML alto). Payload: `reason`, `perclos`. Razões incluem: `PERCLOS`, `YAWN`, `HEAD_DROP`, `FACE_LOST`, `PROLONGED_CLOSE`, `ML_WARNING`. | `VIBRATION_ON` |
| `DROWSINESS_WARNING_ENDED` | Saída do estado `WARNING` (sinais cessaram). | `ALARM_OFF` + `VIBRATION_OFF` |
| `DROWSINESS_STARTED` | Entrada no estado `ALARM` (olhos fechados além do limiar de duração, PERCLOS crítico OU score ML muito alto). Payload: `reason`, `perclos`, `closedForMs`. Razões incluem: `EYES_CLOSED_DURATION`, `PERCLOS_CRITICAL`, `ML_ALARM`. | `ALARM_ON` |
| `DROWSINESS_ENDED` | Saída do estado `ALARM` (olhos reabertos E PERCLOS abaixo do nível de liberação). Payload: `perclos`. | `ALARM_OFF` + `VIBRATION_OFF` |
| `ALARM_ACKNOWLEDGED` | Usuário confirmou via UI que está acordado; alarme silenciado e métricas resetadas. | `ALARM_OFF` + `VIBRATION_OFF` |
| `HEARTBEAT` | Enviado a cada 3s pelo frontend **somente enquanto o estado é ALARM**; renova o watchdog do backend. Payload: `state`. | renova watchdog |

### Eventos do backend (backend → frontend)

| Evento | Descrição |
|--------|-----------|
| `HARDWARE_STATUS` | Estado da conexão serial (`payload.connected`). |
| `ERROR` | Mensagem genérica de erro. |

## Regras de segurança do backend

- O backend é um **sink** de eventos: não envia ACKs para não sobrecarregar o barramento.
- **Watchdog**: se nenhum evento de segurança chegar por `ALARM_HARDWARE_TIMEOUT_S` (15s) durante `ALARM`/`WARNING`, buzzer e vibração são desligados automaticamente (proteção contra aba fechada/travamento do navegador).
- **Desconexão total**: quando o último cliente WebSocket desconecta, todo o alerta de hardware é desligado.
