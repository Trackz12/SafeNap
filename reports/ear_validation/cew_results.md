# Validação do EAR contra dados humanos reais (CEW)

MediaPipe FaceLandmarker (mesmo modelo .task do frontend, 478 landmarks) rodando via mediapipe.tasks.python (Python), EAR calculado com a mesma fórmula/índices de frontend/src/vision/frameAnalyzer.ts (distância 3D, 4 pares verticais por olho, combine_eyes para pose frontal). Dataset: CEW (Closed Eyes in the Wild, NUAA), variante 100x100, ground truth = pasta (ClosedFace/OpenFace). Imagens sem rosto detectado pelo MediaPipe são excluídas da matriz de confusão e reportadas separadamente (limitação do detector, não do EAR).

> **Ressalva importante**: Isto usa um limiar FIXO global para todos os sujeitos do dataset — mais pessimista que a produção real, que calibra o limiar por pessoa (fase aberta+fechada, ver docs/DETECTION.md). Um usuário real, calibrado individualmente, deve ter acurácia igual ou melhor que a reportada aqui.

- Imagens na pasta ClosedFace/: 1193
- Imagens na pasta OpenFace/: 1232
- Sem rosto detectado pelo MediaPipe: 32 (closed) / 4 (open)
- Amostras usadas na matriz de confusão: 2387

## Limiar EAR = 0.21

| | Previsto: fechado | Previsto: aberto |
|---|---|---|
| **Real: fechado** | VP=1152 | FN=8 |
| **Real: aberto** | FP=219 | VN=1008 |

Acurácia: **0.9049** · Precisão: **0.8403** · Recall: **0.9931** · F1: **0.9103**

## Limiar EAR = 0.25

| | Previsto: fechado | Previsto: aberto |
|---|---|---|
| **Real: fechado** | VP=1157 | FN=3 |
| **Real: aberto** | FP=426 | VN=801 |

Acurácia: **0.8203** · Precisão: **0.7309** · Recall: **0.9974** · F1: **0.8436**

