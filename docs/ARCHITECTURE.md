# Arquitetura SAFENAP Web

## Visão Geral
O SAFENAP Web é dividido fisicamente e logicamente em duas grandes camadas para garantir segurança, isolamento e performance:

1. **Frontend (Navegador):** Responsável por captura de imagem, processamento de rede neural via MediaPipe, extração de features para ML, classificação de sonolência (ONNX + modelo do usuário) e lógica de decisão.
2. **Backend (Python local):** Responsável por gerenciar conexões seriais com o hardware (Arduino Nano) e servir como ponte de WebSocket para eventos oriundos do frontend.

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
        WS_S[WebSocketManager] -->|Parsing| SM[SafetyManager]
        SM -->|Comandos Simples| Serial[SerialManager]
    end

    subgraph Hardware [Arduino Nano]
        Serial -->|PySerial| MCU[Microcontrolador]
        MCU --> B[Buzzer]
        MCU --> V[Vibration]
        MCU --> L[LED]
    end

    WS -.->|JSON over WS| WS_S
```

## Benefícios
- **Privacidade:** Nenhuma imagem da câmera sai do navegador do usuário.
- **Performance:** As inferências da IA (FaceLandmarker + ONNX) rodam via WebAssembly/GPU diretamente na máquina do cliente.
- **Desacoplamento:** O Arduino não sabe o que é "olho fechado", ele só sabe o que é "ALARM_ON". O backend não sabe o que é "câmera", ele apenas repassa estados.

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
