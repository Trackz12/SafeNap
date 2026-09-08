# Arquitetura SAFENAP Web

## Visão Geral
O SAFENAP Web é dividido fisicamente e logicamente em duas grandes camadas para garantir segurança, isolamento e performance:

1. **Frontend (Navegador):** Responsável por captura de imagem, processamento de rede neural via MediaPipe, extração de features para ML, classificação de sonolência (ONNX + modelo do usuário) e lógica de decisão.
2. **Backend (Python local):** Responsável por gerenciar conexões seriais com o hardware (Arduino Nano), interpretar o sensor de pressão FSR-402 (`GripMonitor`) e servir como ponte de WebSocket para eventos oriundos do frontend.

O sistema é híbrido por ter **duas fontes de sinal independentes fundidas em OR**: a visão computacional/ML no navegador (olhos, boca, cabeça) e o sensor de pressão na empunhadura do volante, interpretado no backend. Qualquer uma das duas pode disparar o alerta sozinha — nenhuma consegue apagar um alarme ativo da outra (ver `SafetyManager._vision_state` / `_grip_state` em `docs/DETECTION.md` e `docs/HARDWARE.md`).

## Diagrama de Blocos

```mermaid
graph TD
    subgraph Frontend [Frontend (React + Vite)]
        C[CameraManager] -->|Video Stream| M[MediaPipeManager]
        M -->|Face Landmarks| E[EARCalculator]
        E -->|EAR Value| D[DetectionEngine]
        D -->|Eventos Temporais| S[SafetyEngine]
        S -->|Estados Seguros| WS[WebSocketClient]
    end

    subgraph Backend [Backend (FastAPI)]
        WS_S[WebSocketManager] -->|Eventos de visao| SM[SafetyManager]
        GM[GripMonitor] -->|Sinal de garra OR| SM
        SM -->|Comandos Simples| Serial[SerialManager]
    end

    subgraph Hardware [Arduino Nano]
        Serial -->|PySerial: comandos| MCU[Microcontrolador]
        MCU -->|FSR:valor a cada 200ms| Serial
        MCU --> B[Buzzer]
        MCU --> V[4x Motor de Vibração]
        MCU --> L[LED]
        FSR0[FSR-402] --> MCU
    end

    Serial -->|leitura crua| GM
    WS -.->|JSON over WS| WS_S
```

## Benefícios
- **Privacidade:** Nenhuma imagem da câmera sai do navegador do usuário.
- **Performance:** As inferências da IA (FaceLandmarker + ONNX) rodam via WebAssembly/GPU diretamente na máquina do cliente.
- **Desacoplamento:** O Arduino não sabe o que é "olho fechado" nem o que é "sonolência" — ele só sabe atuar (`ALARM_ON`) e ler tensão analógica (`FSR:`). O backend não sabe o que é "câmera", ele apenas repassa estados e interpreta o sinal de pressão.
- **Robustez por redundância:** a fusão OR entre visão e garra cobre o caso em que uma modalidade falha (ex.: óculos escuros/baixa luz atrapalham o EAR, mas a mão sair do volante ainda é detectada; ou vice-versa).

## Pipeline de ML (100% no navegador)

```
MediaPipe FaceLandmarker (478 landmarks)
    ↓
analyzeFrame() → FrameAnalysis (6 features brutas)
    ↓
FeatureExtractor (janela 10 frames) → FeatureVector (18 features)
    ↓
┌─────────────────┬──────────────────┐
│ Modelo Usuário  │ Modelo ONNX      │
│ (CART/RF local) │ (RF quantizado)  │
│ localStorage    │ lazy-loaded WASM │
└────────┬────────┴────────┬─────────┘
         └────┬────────────┘
              ↓
    DrowsinessModel.score [0,1]
              ↓
    DetectionEngine.evaluate() → WARNING/ALARM
```

### Componentes ML (`src/ml/`)

| Módulo | Responsabilidade |
|--------|-----------------|
| `featureOrder.ts` | Contrato das 18 features (ordem = schema do modelo) |
| `vectorToTensor.ts` | FeatureVector → Float32Array(18) |
| `drowsinessModel.ts` | Lazy load ONNX, inferência 200ms throttle, prioriza modelo do usuário |
| `userModel/cart.ts` | CART puro (Gini, maxDepth=6, sem deps externas) |
| `userModel/randomForest.ts` | RF puro (40 árvores, bagging + subamostragem de features) |
| `userModel/userModelStore.ts` | Persistência localStorage, coleta de dados, treino local |
| `mlReasons.ts` | Combina razões rules+ML por modo (rules/ml/hybrid) |
| `modelStatusStore.ts` | Pub/sub do status do modelo (idle/loading/ready/error) |

### Pipeline Python (`ml/`)

Scripts para treinar o modelo ONNX genérico a partir de datasets públicos (NTHU, UTA-RLDD):
- `download_datasets.py` → `extract_features.py` → `train_model.py` → `export_onnx.py`
- Modelo exportado: RF quantizado int8, <100KB, input [1,18] float32, output [1,2] probabilidades
