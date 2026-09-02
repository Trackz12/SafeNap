# Protocolo WebSocket

A comunicação em tempo real entre o Frontend e o Backend ocorre via WebSocket (`ws://localhost:8000/ws`, ou via origem HTTPS do túnel: `wss://<host>/ws`).

## Autenticação

O backend pode exigir um **token compartilhado** para proteger o hardware (buzzer/vibração) e o papel de detector de devices não autorizados na rede.

- **Backend:** defina a env var `SAFENAP_AUTH_TOKEN` (gere com `python -c "import secrets; print(secrets.token_urlsafe(32))"`). Sem a variável, a autenticação fica **desativada** (modo dev) e um aviso é logado.
- **WebSocket:** o token é enviado como query param na URL de conexão — `wss://<host>/ws?token=<TOKEN>`. Conexões recusadas são fechadas com code **1008** (policy violation).
- **REST:** rotas de hardware (`/api/hardware/*`) exigem header `Authorization: Bearer <TOKEN>` (ou `?token=` na query). Respondem **401** quando inválido.
- **Rotas abertas por design:** `/api/status` (diagnóstico) e `/api/client-error` (log de erros — precisa reportar inclusive falhas de auth).
- **Frontend:** configure `VITE_AUTH_TOKEN` (mesmo valor do backend) — o `socketClient` anexa automaticamente à URL do WS e `getAuthHeaders()` injeta o header nos fetches.

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
| `STATE_SNAPSHOT` | Enviado imediatamente após um cliente conectar. Carrega o estado compartilhado completo (`payload.has_detector`, `payload.detector`, `payload.metrics`, `payload.session`, `payload.calibration`, `payload.user_model`). |
| `ERROR` | Mensagem genérica de erro. |

## Sincronização multi-dispositivo (detector/viewer)

O backend atua como **relay + persistência** para um frontend compartilhado entre
vários dispositivos. Regra central: **frames de vídeo nunca passam pelo WebSocket** —
apenas métricas derivadas, estado e modelos serializados (processamento de câmera e
ML permanecem 100% no device detector, conforme a arquitetura).

### Papéis

- **Detector**: único device que roda a câmera e a detecção (MediaPipe + ONNX/RF).
  Publica métricas derivadas e o estado.
- **Viewer(s)**: demais devices. Não abrem câmera; aplicam os dados recebidos nos
  próprios stores e exibem o mesmo painel em tempo real (gauge, gráfico, sessão,
  alertas, calibração e modelo ML).

### Eventos de negociação de papel

| Evento | Direção | Descrição |
|--------|---------|-----------|
| `DETECTOR_CLAIM` | front → backend | Device pede o papel de detector. O backend só concede se o papel estiver livre. Retorna `DETECTOR_ASSIGNED` (aceito) ou `DETECTOR_TAKEN` (já ocupado; o device vira viewer). |
| `DETECTOR_RELEASE` | front → backend | Detector abre mão do papel (ex: câmera parada). Backend emite `DETECTOR_CLEARED` para os demais. |
| `DETECTOR_ASSIGNED` | backend → front | Claim aceito; device vira detector e passa a publicar. |
| `DETECTOR_TAKEN` | backend → front | Outro device já é detector (`payload.owner` = session_id do dono). O requisitante vira viewer. |
| `DETECTOR_CLEARED` | backend → front | Detector desconectou ou liberou o papel; viewers voltam a poder solicitar a vaga. |

### Eventos de sincronização (detector → backend → viewers)

| Evento | Payload | Descrição |
|--------|---------|-----------|
| `METRICS_UPDATE` | `payload.metrics` (DetectionMetrics) | Métricas derivadas (EAR, PERCLOS, estado NORMAL/WARNING/ALARM, threshold, score ML…). Enviadas a ~3/s pelo detector. |
| `SESSION_SYNC` | `payload.session` (snapshot curto) | Contadores da sessão + últimos pontos do histórico (gráfico). Enviado a ~1/s. |
| `CALIBRATION_PROGRESS` | `isCalibrating`, `phase`, `openCount`, `closedCount`, `outcome` | Progresso ao vivo da calibração guiada do detector. |
| `CALIBRATION_SYNC` | `payload.calibration` | Resultado FINAL da calibração (baseline, threshold, noseDrop, calibratedAt, skipped). Persistido pelo backend e reenviado no `STATE_SNAPSHOT`. |
| `MODEL_SYNC` | `payload.model` (UserRF) | Modelo RF do usuário treinado no detector. Persistido e distribuído. |
| `CALIBRATION_REQUEST` | `payload.action` = `start` \| `cancel` | Viewer pede ao detector para iniciar/cancelar a calibração na câmera. O backend roteia diretamente ao detector. |

### Persistência do backend

O backend salva `CALIBRATION_SYNC` e `MODEL_SYNC` em `backend/safenap_shared.json`
(debounce ~0.5s) para repassá-los a viewers que conectem depois. O papel de detector
fica apenas em memória. Ao conectar, todo cliente recebe `STATE_SNAPSHOT` com o estado
compartilhado vigente, e viewers aplicam calibração + modelo imediatamente.

### Regras de segurança do backend

- O backend é um **sink** de eventos: não envia ACKs para não sobrecarregar o barramento.
- **Watchdog**: se nenhum evento de segurança chegar por `ALARM_HARDWARE_TIMEOUT_S` (15s) durante `ALARM`/`WARNING`, buzzer e vibração são desligados automaticamente (proteção contra aba fechada/travamento do navegador).
- **Desconexão total**: quando o último cliente WebSocket desconecta, todo o alerta de hardware é desligado.
- **Desconexão do detector**: quando o detector desconecta, o papel é liberado (`DETECTOR_CLEARED`) e os dados ao vivo (metrics/session) são limpos; calibração e modelo persistem para o próximo estado.
