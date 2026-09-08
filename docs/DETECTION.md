# Engine de Detecção (Detection Engine)

A detecção roda **100% no navegador** (regra de privacidade: nenhum frame de vídeo sai do cliente). O MediaPipe FaceLandmarker extrai 478 pontos faciais; a partir deles são calculados, por frame, quatro sinais independentes que alimentam a máquina de estados.

> **Segunda fonte de sinal (fora do navegador):** o sensor de pressão FSR-402
> na empunhadura do volante é lido pelo Arduino e interpretado pelo
> `GripMonitor` no backend (baseline adaptativa + histerese + debounce — ver
> `docs/HARDWARE.md`). Esse sinal é fundido em **OR por severidade** com o
> estado de visão/ML descrito abaixo dentro do `SafetyManager`: o estado
> efetivo do hardware é sempre o mais grave entre os dois, e nenhuma fonte
> consegue apagar um alarme ativo da outra (ver `docs/WEBSOCKET_PROTOCOL.md`,
> evento `GRIP_STATUS`).

## Sinais por frame (`vision/frameAnalyzer.ts`)

| Sinal | Cálculo | Uso |
|-------|---------|-----|
| **EAR** (Eye Aspect Ratio) | razão entre distâncias verticais das pálpebras e distância horizontal do olho (8 pontos por olho — 4 pares verticais), combinado entre os dois olhos | olhos abertos/fechados |
| **Mouth Aspect Ratio** | abertura vertical da boca ÷ largura da boca | bocejo |
| **Nose Drop Ratio** | queda vertical da ponta do nariz em relação ao eixo dos olhos, normalizada pela altura do rosto | cabeça abaixando |
| **Yaw Ratio** | deslocamento horizontal do nariz em relação ao centro dos olhos (futuro: desatenção) | reservado |

## Detecção de olhos fechados (com histerese e confirmação)

- O EAR passa por um **filtro de mediana** (janela de 3 frames) antes da avaliação — mata picos de jitter de 1 frame sem o atraso médio de um EMA (ver seção *Suavização do EAR*).
- Olhos só são marcados como fechados após **N frames consecutivos abaixo do threshold** (`closeConfirmFrames`: 4 no leve, 3 no padrão, 2 no alta) — um frame ruidoso isolado não dispara mais o estado.
- Só reabrem quando `EAR > threshold × hysteresisFactor` (padrão 1.15) — evita flicker de estado quando o EAR oscila perto do limite.
- Cada segmento fechado é registrado (início/fim) para PERCLOS e contagem de piscadas (duração entre 50–400ms conta como piscada).

## PERCLOS — padrão da indústria

Proporção do tempo em que os olhos ficaram fechados dentro de uma janela deslizante de **60 segundos** (aproximação da métrica PERCLOS P80). É a base do escalonamento de severidade e muito mais robusta que avaliar apenas um episódio contínuo.

**Anti-falso-positivo:** segmentos com duração menor que `perclosIgnoreMs` (400ms — duração típica de uma piscada) são **excluídos do PERCLOS**. Piscadas normais continuam sendo contadas, mas não inflam a métrica de sonolência.

## Micro-sono (MICROSLEEP) — detector dedicado de evento agudo

O PERCLOS é uma métrica de **janela de 60s**: um micro-sono isolado de 1.5–3s fica diluído na média e demora a escalar a severidade. O detector de micro-sono reage ao **evento agudo** em tempo real:

- **Gatilho:** EAR < `threshold × microsleepThresholdFactor` (0.55 — olho *bem* fechado, não mero semi-fechado) sustentado por `microsleepAlarmMs` (600–2000ms conforme preset).
- **Confirmação:** exige `closeConfirmFrames` frames consecutivos — mesmo anti-jitter do fechamento normal.
- **Cooldown** (`microsleepCooldownMs`, 8–12s): evita re-alarmar dentro da mesma onda de sonolência.
- **Prioridade máxima:** se micro-sono e outra razão disparam juntos, `MICROSLEEP` vence (é o sinal mais crítico).

Fisiologicamente, micro-sonos são os marcadores mais perigosos de sonolência ao volante: o motorista perde consciência por 1–3s sem perceber. Este detector cobre a faixa que ficava entre o "PROLONGED_CLOSE" (aviso) e o fechamento longo (alarme).

## Tendência de EAR (EAR_TREND) — fase prodrômica da sonolência

Sonolência real **evolui gradualmente**: a pálpebra desce aos poucos (fadiga muscular) antes de qualquer fechamento franco. A máquina de estados era puramente instantânea nisso — um motorista cujo EAR decai de 0.30 → 0.22 lentamente não disparava nada até cruzar o threshold.

- **Buffer de tendência:** amostras de EAR coletadas **apenas com olhos abertos** (piscadas não contaminam o declínio) numa janela de 60s (`longEarBuffer`).
- **Sinal:** fração de declínio do EAR recente vs `baselineEar` calibrado. Se `(baseline - recent) / baseline > earTrendWarnFraction` (15–20% conforme preset), dispara WARNING `EAR_TREND`.
- **Requer calibração:** sem baseline calibrado não há tendência (retorna null — não dispara com o threshold padrão).
- **Alvo exato:** 20 amostras mínimas (~2s de dados) antes de avaliar — evita disparo por ruído de poucos frames.

Isso dá ao sistema a capacidade de avisar o motorista **antes** do fechamento crítico: "pálpebras pesando" em vez de esperar o micro-sono.

## Máquina de estados (3 estágios, `detection/detectionEngine.ts`)

```
NORMAL ──(sinal de aviso)──► WARNING ──(sinal crítico)──► ALARM
   ▲              ▲                                         │
   └──────────────┴─── (recovery: olhos abertos + PERCLOS < release level)
```

### NORMAL → WARNING (razões)
| Razão | Condição (preset padrão) |
|-------|--------------------------|
| `PERCLOS` | PERCLOS ≥ 25% |
| `YAWN` | boca aberta sustentada ≥ 400ms (aspect ≥ 0.65), com cooldown de 10s |
| `HEAD_DROP` | queda do nariz acima do baseline + margem por ≥ 2000ms |
| `FACE_LOST` | rosto ausente por ≥ 5s |
| `PROLONGED_CLOSE` | olhos fechados ≥ 700ms |
| `EAR_TREND` | EAR médio caiu > 18% abaixo do baseline calibrado na última 1min (fase prodrômica — pálpebras pesando gradualmente; medido apenas com olhos abertos) |

### → ALARM (razões)
| Razão | Condição (preset padrão) |
|-------|--------------------------|
| `MICROSLEEP` | olhos **bem fechados** (EAR < threshold × 0.55) sustentado por ≥ 1800ms, com cooldown de 10s — detector dedicado independente do PERCLOS, captura o evento agudo que a janela de 60s dilui |
| `EYES_CLOSED_DURATION` | olhos fechados continuamente ≥ 1500ms |
| `PERCLOS_CRITICAL` | PERCLOS ≥ 45% |

### Saída do ALARM
Requer olhos reabertos **E** PERCLOS < 15% (release level) — evita sair do alarme só por uma piscada rápida. Pode descer direto para WARNING se ainda houver sinal de aviso ativo.

O usuário pode confirmar que está acordado via UI (`ALARM_ACKNOWLEDGED`), que silencia o alarme e zera as métricas da sessão.

## Presets de sensibilidade

| Preset | duração p/ alarme | PERCLOS warning/alarm | rosto ausente | bocejo | frames confirmação |
|--------|-------------------|----------------------|---------------|--------|--------------------|
| `lenient` (leve) | 2000ms | 30% / 55% | 5s | aspect 0.70 | 4 |
| `standard` (padrão) | 1500ms | 25% / 45% | 5s | aspect 0.65 | 3 |
| `strict` (alta) | 1000ms | 20% / 38% | 4s | aspect 0.60 | 2 |

## Calibração (bifásica — aberto + fechado, guiada por wizard)

A calibração é **obrigatória para alertas precisos** e acontece via um **wizard guiado** (`CalibrationWizard.tsx`) que abre automaticamente como overlay sobre a câmera assim que ela é iniciada. O fluxo conduz o usuário passo a passo:

1. **Intro:** explica o procedimento (rosto de frente, olhos abertos ~2s, fechados ~2s) e oferece "Pular (precisão reduzida)".
2. **Stale prompt:** se já existe calibração com mais de 6h (`RECALIBRATION_PROMPT_MS`), o wizard pergunta se quer recalibrar ou usar a atual.
3. **Fase 1 — Olhos abertos:** barra de progresso + contador regressivo + aviso de rosto ausente; o avanço para a fase 2 é **automático** ao atingir 20 amostras.
4. **Fase 2 — Olhos fechados:** mesma UI; finalização e cálculo do threshold são **automáticos**.
5. **Resultado:** tela de sucesso com baseline/threshold calculados, ou tela de erro com motivo (timeout, gap, amostras insuficientes) e opção de tentar de novo.

**Detecção fica bloqueada até calibrar:** `detectionEngine.evaluate` só roda quando `calibrationManager.canEvaluate()` é verdadeiro — ou seja, com calibração válida (`safenap_calibration_v3`) OU quando o usuário optou explicitamente por "Pular" (`skipWithDefault`, usa o threshold padrão com precisão reduzida, sinalizado no painel). O coletor de dados ML (`mlDataCollector`) também não coleta frames sem calibração para não contaminar o modelo.

O cálculo do threshold permanece `clamp((openMedian + closedMedian) / 2, 0.12, 0.45)`.

### Driver de calibração (`safety/calibrationManager.ts`)
Toda a lógica de condução das fases mora no manager (não no React): um driver interno (interval de 200ms) avança de fase ao atingir o mínimo de amostras, finaliza a calibração e aborta com **timeout por fase** (`MAX_CALIBRATION_PHASE_MS = 12s`). O resultado da última tentativa fica exposto em `getOutcome()` (`ok | timeout | gap | insufficient_samples | null`).

### Proteções e robustez
- **Settle delay (1.2s):** amostras coletadas nos primeiros 1.2s da calibração são descartadas — dá tempo para auto-exposição/auto-foco da câmera estabilizarem antes da captura.
- **Gap mínimo:** se `openMedian - closedMedian < 0.05`, o usuário provavelmente não fechou os olhos. A calibração é descartada (mantém a baseline anterior) e exibe erro guiado.
- Exige no mínimo **20 amostras por fase** (≈2s cada); abaixo disso a calibração falha e pede nova tentativa.
- **Persistência em `localStorage`** (`safenap_calibration_v3`): baseline, threshold, nose-drop, data e preset são salvos e restaurados automaticamente nas próximas sessões. A chave foi versionada (v1→v3) em função da calibração bifásica.
- A calibração pausa a avaliação de estados (`detectionEngine.evaluate` fica desabilitado) enquanto coleta amostras — sem falsos alarmes durante a captura.
- Se a câmera é desligada no meio da calibração, esta é cancelada silenciosamente (baseline anterior mantida).

### Pré-processamento da imagem (`vision/mediapipe.ts`)
O canvas de detecção aplica uma correção leve de brilho/contraste (`brightness(1.06) contrast(1.10)` via `ctx.filter`) para estabilizar landmarks em ambientes com pouca luz ou back-lighting. Browsers antigos ignoram `ctx.filter` silenciosamente — fallback seguro.

### Trava de segurança
O botão "Calibrar" do painel fica **desabilitado** enquanto a câmera está desligada (estado publicado por `cameraStatusStore`).

## Estado compartilhado entre dispositivos (detector/viewer)

O frontend pode ser aberto em vários dispositivos simultaneamente e todos enxergam o **mesmo estado ao vivo** (gauge, gráfico, sessão, alertas, calibração e modelo ML). Arquitetura conforme AGENTS.md:

- **A câmera só roda no device detector.** Frames de vídeo **nunca** passam pelo WebSocket — só métricas derivadas e modelos serializados.
- O device que clica em "Iniciar Câmera" reivindica o papel de detector (`DETECTOR_CLAIM`). Se a vaga estiver ocupada, vira **viewer** e espelha os dados recebidos (`METRICS_UPDATE` a ~3/s, `SESSION_SYNC` a ~1/s, `CALIBRATION_PROGRESS`, `CALIBRATION_SYNC`, `MODEL_SYNC`).
- **Bloqueio de detecção:** em qualquer device, `detectionEngine.evaluate` só roda com `calibrationManager.canEvaluate()` — calibração válida OU "Pular (precisão reduzida)". Viewers que não calibraram e não foram sincronizados também não geram alertas.
- **Calibração compartilhada:** o resultado da calibração bifásica do detector é persistido pelo backend (`backend/safenap_shared.json`) e aplicado em todos os viewers no próximo `STATE_SNAPSHOT`. Viewers podem pedir calibração ao detector (`CALIBRATION_REQUEST`) e acompanham as fases em tempo real via `CALIBRATION_PROGRESS` — inclusive com o wizard guiado em modo remoto.
- Ao conectar, todo cliente recebe `STATE_SNAPSHOT` com o estado vigente; o backend limpa métricas/sessão ao vivo quando o detector desconecta e libera a vaga para outro dispositivo.

## Robustez a óculos (`combineEyes`)

Óculos são a principal fonte de falso "olho fechado": reflexos nas lentes deslocam os landmarks de **um** olho. Duas defesas no `frameAnalyzer.ts`:

1. **EAR estendido (8 pontos)**: cada olho usa 4 pares verticais em vez de 2 — um reflexo que corrompe 1–2 landmarks tem o erro diluído pela média dos demais.
2. **Combinação robusta dos olhos**: quando os olhos discordam fortemente (razão entre o menor e o maior EAR < 0.55), o frame é tratado como reflexo/oclusão de um olho e o **EAR do olho mais aberto** é usado. Sonolência real fecha os **dois** olhos, então isso não mascarada o sinal de sono — só evita falsos alarmes por reflexo.
3. O **EAR do olho mais aberto** (`combineEyes(0.30, 0.08) → 0.30`) mantém a detecção ativa: ambos os olhos fechados continuam gerando EAR baixo e disparando normal.

## Suavização do EAR (alta variação)

O EAR cru oscila por três causas distintas, tratadas separadamente:

1. **Pose da cabeça (invariância 3D)**: o MediaPipe fornece o eixo `z` (profundidade). O `frameAnalyzer` calcula o EAR com **distâncias 3D** (`sqrt(dx² + dy² + dz²)`), não 2D. Inclinar a cabeça encolhe a projeção 2D do olho (falso "fechando"), mas a abertura real em 3D permanece constante — olhar para baixo/lado não derruba mais o EAR.
2. **Jitter dos landmarks**: picos ruidosos isolados não devem contar. O `detectionEngine` aplica um **filtro de mediana** (janela de 3 frames, `EAR_SMOOTHING_WINDOW`) ao EAR: um pico isolado é removido; um fechamento real persiste e a mediana o acompanha em ~2 frames. O buffer é limpo quando o rosto é perdido (`processNoFace`) e em `reset()`.
3. **Piscadas são variação normal**: cada piscada derruba o EAR para ~0.1 e volta — é o maior "jitter" observado. Piscadas não geram alarmes porque a confirmação por N frames exige fechamento sustentado e o PERCLOS exclui trechos com duração de piscada (<400ms).

## Qualidade do rosto (`vision/frameAnalyzer.ts`)

Antes de computar os sinais, o frame é validado para evitar landmarks instáveis (fonte comum de falsos positivos):
- **Rosto pequeno demais** (largura entre os olhos < 15% da imagem) → frame descartado (tratado como rosto ausente).
- **Rosto cortado pelas bordas** (olhos, nariz ou boca dentro de 3% da margem) → frame descartado.
- **Aspect ratio do vídeo preservado** no canvas de detecção — no celular (vídeo retrato) a imagem não é mais esticada para 4:3, eliminando a distorção dos landmarks.

## Métricas de sessão (`detection/sessionStats.ts`)

- Piscadas contadas (e taxa por minuto)
- Episódios de olhos fechados prolongados
- Avisos emitidos
- EAR médio da sessão
- Histórico EAR + PERCLOS dos últimos 90s (gráfico ao vivo na UI)

## Extração de features para ML (`detection/featureExtractor.ts`)

O módulo `FeatureExtractor` mantém uma **janela deslizante** dos últimos N frames (default 10, ≈1s a 10fps) e computa **features derivadas** para alimentar um classificador de sonolência (Fase 2 — ML). O módulo é puro (sem dependências de ciclo, sem React), exporta funções de matemática para teste isolado, e segue o padrão singleton do projeto.

### FeatureVector (18 features)

| # | Feature | Origem | Descrição |
|---|---------|--------|-----------|
| 1 | `ear` | FrameAnalysis | EAR combinado do frame atual |
| 2 | `earL` | FrameAnalysis | EAR olho esquerdo |
| 3 | `earR` | FrameAnalysis | EAR olho direito |
| 4 | `mouthAspect` | FrameAnalysis | Abertura da boca |
| 5 | `noseDropRatio` | FrameAnalysis | Queda do nariz |
| 6 | `yawRatio` | FrameAnalysis | Deslocamento horizontal |
| 7 | `earMean` | Janela | Média do EAR na janela |
| 8 | `earStdDev` | Janela | Desvio padrão populacional (variabilidade) |
| 9 | `earMin` | Janela | Dip mais profundo |
| 10 | `earMax` | Janela | Pico mais alto |
| 11 | `earTrendPerSec` | Janela | Inclinação do EAR/s (regressão linear) |
| 12 | `blinkRate` | DetectionEngine | Piscadas/min (janela 60s) |
| 13 | `msSinceLastBlink` | DetectionEngine | ms desde última piscada |
| 14 | `perclos` | DetectionEngine | PERCLOS (janela 60s) |
| 15 | `mouthMean` | Janela | Média da abertura bucal |
| 16 | `mouthMax` | Janela | Pico da abertura (bocejo) |
| 17 | `mouthTrendPerSec` | Janela | Inclinação da boca/s |
| 18 | `noseDropMean` | Janela | Média da queda do nariz |

### Comportamento
- **Warm-up:** retorna `null` até acumular `minFramesForFeatures` (default 3). Segue o padrão de `analyzeFrame()`.
- **Reset:** `featureExtractor.reset()` chamado quando o rosto é perdido (`processNoFace`), em `reset()` e em `ackAlarm()`.
- **Gap de frame:** se a diferença temporal entre frames excede `maxFrameGapMs` (default 1000ms), o buffer é limpo (descontinuidade).
- **NaN defensivo:** frames com valores não-finitos são silenciosamente ignorados.
- **Fora de ordem/duplicado:** frames com timestamp ≤ ao último registrado são ignorados.

### Integração com DetectionEngine
- `processFrame()`: calcula `perclos`, `blinkRate`, e chama `featureExtractor.extract(frame, now, context)` antes do `metricsStore.publish()`. O `FeatureVector` resultante é armazenado em `lastFeatureVector` (acessível via getter para futuras fases de ML).
- `getLastBlinkAt()`: novo getter público que expõe o timestamp da última piscada (usado para `msSinceLastBlink` sem duplicar lógica de piscada).

## Detecção de sonolência via ML (`src/ml/`)

O sistema de ML roda **100% no navegador** usando `onnxruntime-web` (WASM) para classificar o estado de sonolência a partir das 18 features extraídas por frame.

### Arquitetura

```
FrameAnalysis → featureExtractor.extract() → FeatureVector (18 feats)
                                                 ↓
                                    drowsinessModel.inferAsync() → score [0,1]
                                                 ↓
                                    detectionEngine.evaluate() → WARNING/ALARM
```

### Componentes

| Arquivo | Responsabilidade |
|---------|-----------------|
| `ml/featureOrder.ts` | Contrato das 18 features (ordem exata = schema do modelo) |
| `ml/thresholds.ts` | Limiares ML: WARNING=0.85, ALARM=0.95, RELEASE=0.70 |
| `ml/vectorToTensor.ts` | FeatureVector → Float32Array(18), com sentinel para null e NaN |
| `ml/modelStatusStore.ts` | Pub/sub do status: idle → loading → ready/error |
| `ml/drowsinessModel.ts` | Lazy load do ONNX, inferência assíncrona (200ms throttle), mediana de 3 |
| `ml/smoothing.ts` | Mediana pura para suavizar o score |
| `ml/mlReasons.ts` | Funções puras: combina razões de regra + ML conforme o modo |

### Modos de detecção

| Modo | WARNING | ALARM |
|------|---------|-------|
| `rules` | Só regras (PERCLOS, bocejo, etc.) | Só regras |
| `ml` | ML ≥ 0.85 → ML_WARNING; fallback regras | ML ≥ 0.95 → ML_ALARM; fallback regras |
| `hybrid` | ML **ou** regras (qualquer um dispara) | ML **ou** regras |

Modo default: `hybrid`. Togglável via `detectionEngine.setMode()`.

### Inferência

- **Lazy loading:** `drowsinessModel.initialize()` carrega o ONNX via dynamic import (não bloqueia a câmera).
- **Throttle:** inferência no máximo 1× a cada 200ms (`INFERENCE_INTERVAL_MS`).
- **Mediana:** score suavizado por janela de 3 (spike rejection).
- **Staleness gate:** score com mais de 1500ms é descartado (fallback para regras).
- **Fallback:** se o modelo não carrega ou dá erro → `getLastScore()` retorna `null` → engine continua 100% em regras.

### Modelo ONNX

- **Treino:** `ml/scripts/train.py` treina Random Forest sobre dados do NTHU/UTA-RLDD, exporta ONNX quantizado (int8).
- **Deploy:** `frontend/public/models/drowsiness.onnx` (<100KB).
- **WASM:** `onnxruntime-web` (lazy-loaded, ~21MB WASM, ~390KB JS em chunk separado).
- **Pipeline completo:** `ml/README.md` documenta download → extração → treino → deploy.

### UI

- `MlStatusCard`: mostra status do modelo (carregando/pronto/erro) e score de sonolência em %.
- `StatusGauge` e `StatusDashboard`: labels para `ML_WARNING` e `ML_ALARM`.
- `App.tsx`: `MlStatusCard` entre CalibrationPanel e StatusDashboard.

### Dependências

- **Frontend:** `onnxruntime-web` (lazy-loaded via dynamic import).
- **Python (ml/):** `scikit-learn`, `onnx`, `skl2onnx`, `onnxruntime`, `pandas`, `numpy`, `opencv-python-headless`, `mediapipe`.
