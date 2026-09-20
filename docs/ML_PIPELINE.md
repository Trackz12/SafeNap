# Pipeline de ML do SafeNap — auditoria, reprodução e limites

> Escrito a partir do **código** (fonte de verdade) e de execuções reais em 2026-09-19.
> Onde algo não foi medido ou validado, está dito. Nenhuma métrica aqui é inventada.

## 0. Resumo honesto

O SafeNap **tem** uma implementação de ML (inferência ONNX no navegador, extração de 18
features, scripts de treino/avaliação, model card). O modelo embarcado, porém, **não foi
treinado nem avaliado com pessoas reais**: é um Random Forest treinado em dados sintéticos
escritos à mão. Portanto **não há evidência experimental de desempenho de detecção de
sonolência**. O que existe de evidência com dados humanos reais é só a classificação de
olho aberto/fechado por EAR no CEW (`reports/ear_validation/`) — e isso **não é** detecção
de sonolência.

Por isso, desde esta revisão, o ML é um sinal **auxiliar**: pode gerar `WARNING`, mas
**não origina `ALARM` sozinho** (§7).

## 1. Status de cada parte

| Status | O que |
|---|---|
| **IMPLEMENTADO** | Inferência ONNX local (`onnxruntime-web`, WASM) · extração de 18 features · modelo do usuário (RF em JS, localStorage) · `extract_features.py` (FaceLandmarker, manifesto, split por sujeito) · `train_model.py` (4 candidatos, GroupKFold, ONNX + model card) · `evaluate.py` · métricas completas |
| **VALIDADO** (por teste automatizado — engenharia, não desempenho) | Ordem/schema das 18 features (Python ↔ TS) · geometria, janela, PERCLOS e piscadas idênticos Python ↔ TS (tolerância 1e-9) · contrato de I/O do ONNX com ORT Python **e** ORT-web reais · P(DROWSY) do ORT-web = ORT Python em 43 vetores (Node) e em 12 vetores no Chromium (diferença 0) · pipeline de treino reproduzível (mesma seed → mesmo `.onnx`, byte a byte) · política ML × regras · DetectionEngine em 15 cenários sintéticos (verificação de especificação) · EAR open/closed no CEW (2 387 imagens; ≠ sonolência) |
| **EXPERIMENTAL** | O ONNX de sonolência embarcado (só dados sintéticos) · o modelo do usuário (destilado do ONNX sintético, sem holdout) · limiares ML 0,85/0,95/0,70 · pesos da fusão multi-sinal |
| **NÃO VALIDADO** | Eficácia em motoristas reais ou em direção real · desempenho em NTHU-DDD / UTA-RLDD (não disponíveis aqui) · redução de acidentes · desempenho clínico · FPS/latência/CPU/memória do MediaPipe em navegadores reais · o app completo com câmera em navegador real (o ORT-web foi verificado em Chromium, ver §9) |

## 2. Pipeline real (o que o código executa)

```
<video> → canvas 320px → FaceLandmarker (CPU, loop setTimeout 100 ms ≈ ≤10 FPS)      vision/mediapipe.ts
  ├─ sem rosto        → detectionEngine.processNoFace() (zera janela e ML)
  └─ com rosto → analyzeFrame() → FrameAnalysis (6 valores; null se rosto inválido = frame ignorado)
        → detectionEngine.processFrame():
            • EAR mediana-3 → regras (limiar CALIBRADO, PERCLOS 60 s, microsleep, bocejo, head-drop, tendência, piscadas lentas)
            • featureExtractor (janela 10 frames) → 18 features
                 ├ mlDataCollector.collectFrame  (pseudo-rótulos → modelo do usuário)
                 └ drowsinessModel.inferAsync    (throttle 200 ms; 1 run() em voo)
                      ONNX (modelo do usuário só com VITE_ENABLE_USER_MODEL=true, 1ª prioridade; ver §12)  →  mediana-3  → score P(DROWSY)
            • evaluate(): score fresco (≤1,5 s; ≤8 s se já em ALARM) senão null
                 → combineWarning/AlarmReason (regras + ML, política §7) → fusão multi-sinal → histerese
        → WARNING/ALARM → wsClient.sendEvent → backend → Arduino
```

O ML é ignorado quando: o score está velho; o ONNX não carregou e não há modelo do usuário;
o vetor tem NaN/Infinity; o modo é `rules` (a inferência ainda roda, só não é usada).
Frames de vídeo nunca saem do navegador (só eventos/estado; o modelo do usuário sincronizado
são as árvores, não imagens).

## 3. As 18 features — fonte única de verdade

`shared/feature_schema.json` (ordem, sentinela, janela, índices de landmarks). Lido por
`ml/features/schema.py`; `frontend/src/ml/featureOrder.ts` o espelha, e há testes de paridade
**por posição** nos dois lados (`featureSchema.test.ts`, `ml/tests/test_schema_parity.py`, que
lê o `.ts` como texto). Mudar a ordem invalida todo ONNX já treinado (o `schema_hash` do model
card detecta isso).

Unidades e cálculo: ver `units` no JSON. Pontos de atenção:

- `msSinceLastBlink`: `null` no TS vira **-1** (sentinela) em **todos** os caminhos
  (`featureVectorToArray`); antes o modelo do usuário usava 0 na coleta.
- NaN/Infinity: `featureVectorToArray` devolve `null` → nenhuma inferência nem coleta.
- Sem normalização (as features entram cruas); as árvores não precisam.
- Dependência da qualidade do rosto: `analyzeFrame` descarta rosto pequeno/na borda.
- **Vazamento de rótulo (leakage):** `perclos`/`blinkRate` são derivados do EAR e do tempo, não do
  rótulo. O risco real de vazamento está no *split* — tratado em §5.
- Quirk herdado do TS e mantido no Python de propósito: a "altura do rosto" do `noseDropRatio`
  usa `z=0` no ponto médio dos olhos (inclui `chin.z²`).

### Paridade treino ↔ inferência

Antes desta revisão o Python divergia do frontend (medido): EAR **2×** maior (`Σ/2h` vs `média/h`),
pares de landmarks verticais diferentes, `noseDropRatio` com outra definição, sem combinação por
yaw, `perclos` binário por frame (`ear<0,15`), `blinkRate=0`, 30 fps (janela de 0,33 s vs ~1 s).
Agora `ml/features/` reproduz o frontend e `shared/feature_golden.json` (gerado pelo Python,
reproduzido pelo `analyzeFrame`, `FeatureExtractor` e `DetectionEngine` **reais** em TS) prova
igualdade até 1e-9.

Diferenças inevitáveis (documentadas): (a) o limiar de EAR offline é fixo (`--ear-threshold`,
padrão 0,21 do CEW), não a calibração individual; (b) a paridade usa rostos sintéticos
determinísticos — assume-se que o FaceLandmarker Python e o JS produzem landmarks equivalentes
(mesmo `.task`; ver CEW); (c) o navegador processa 320 px (use `--width 320`).

## 4. Dataset e o que é uma "linha de treino"

Uma linha = as 18 features no instante `t_ms` de **um vídeo de um sujeito** (janela dos últimos
10 frames a ~10 fps + estado de PERCLOS/piscadas de 60 s), com o rótulo do vídeo/segmento
(1 sonolento, 0 alerta) vindo de um **manifesto** (`video,subject_id,label[,start_s,end_s]`).

- **NTHU-DDD e UTA-RLDD não estão no repositório nem neste computador** (exigem download/aprovação
  manual; `download_datasets.py` tem IDs `FILL_ME`). **Nenhum treino real foi feito.**
- O mapeamento dos rótulos do UTA-RLDD (0/5/10) para binário é uma decisão metodológica que o
  script **não assume** — vem do manifesto.
- O CSV de features é um dado derivado desses datasets; **não deve ser commitado** (licenças).

## 5. Treino, split, métricas

`ml/scripts/train_model.py`:

1. Holdout **por sujeito** (`GroupShuffleSplit`; nenhum sujeito em treino e teste; exige ≥ 4
   sujeitos e as duas classes nos dois lados). O `train_test_split` aleatório por linha anterior
   vazava janelas quase idênticas entre treino e teste.
2. Candidatos: Logistic Regression, Decision Tree, Random Forest, Gradient Boosting — comparados
   por `GroupKFold` só no treino. Seleção por **PR-AUC da classe DROWSY** (robusto a
   desbalanceamento), desempate por recall.
3. O melhor é reajustado no treino e avaliado **uma vez** no teste; esse mesmo modelo é exportado.
4. Export ONNX (sem quantização: árvores não têm MatMul/Gemm; o `quantize_dynamic` anterior era
   in-place e inócuo) + verificação de paridade sklearn↔ORT (`max|Δp| < 1e-4`) e do contrato de I/O.
5. `model_card.json` (seed, hiperparâmetros, hash do CSV e do ONNX, sujeitos de treino/teste,
   versões das bibliotecas, `schema_hash`) e `metrics.json`.

Métricas (`ml/evaluation/metrics.py`): accuracy, balanced accuracy, precision, recall/sensibilidade,
especificidade, F1, FNR, FPR, NPV, matriz de confusão, ROC-AUC, PR-AUC — por classe. Leitura:

- **Falso negativo** (recall baixo em DROWSY) = sonolência não detectada — o pior erro para segurança.
- **Falso positivo** (especificidade baixa) = alarme falso → fadiga de alarme e perda de confiança.
- **Precisão** depende da prevalência de DROWSY no teste: não é comparável entre datasets.
- Acurácia sozinha engana (95 % “acertando” um conjunto 95/5 que nunca detecta sonolência —
  há teste disso). **Nenhuma dessas métricas autoriza dizer que o sistema “é seguro”.**

### Métricas obtidas

| Alvo | Resultado real |
|---|---|
| Modelo ONNX de sonolência | **Nenhuma.** Sem dataset real não há avaliação. O model card do embarcado tem `metrics: null` de propósito (métricas em dados sintéticos seriam circulares). |
| EAR open/closed no CEW (≠ sonolência) | Limiar 0,21: acc 0,905 · prec 0,840 · recall 0,993 · F1 0,910 (2 387 imagens). Ver `reports/ear_validation/`. |
| Pipeline de treino | Testado com CSV **sintético** só para exercitar a máquina; esses números não são desempenho. |

## 6. O modelo embarcado (inspecionado, não assumido)

`frontend/public/models/drowsiness.onnx` (14 KB, sha256 no model card): `TreeEnsembleClassifier`
(100 árvores, ~3 nós cada, `post_transform=NONE`), entrada `features [N,18] float`, saídas `label`
e `probabilities [N,2]`, classes `[0,1]`, opset 19, `skl2onnx 1.20`. **É** um Random Forest, mas
de dados sintéticos: `ml/scripts/generate_realistic_model.py`. Não é int8 nem “<100 KB de NTHU/UTA”
como a doc antiga afirmava.

Achados verificados:

- **Escala sintética ≠ escala real.** O gerador usa `noseDropRatio` 0–0,35; o frontend produz ~0,3–0,5.
  Um vetor plausível de pessoa **acordada** recebe P(drowsy) = **0,39** (0,0 com a escala sintética).
- **Runtimes divergem em `label`/`probabilities[0]`.** Para o mesmo arquivo e entrada, o ORT-web 1.27
  devolve `probabilities=[-p, p]` e `label=1`; o ORT Python devolve `[1-p, p]`, `label=0`. Só o
  índice 1 coincide (verificado em 43 vetores). O frontend lê apenas o índice 1.
- **Reprodutibilidade do artefato:** regenerar o modelo dá Δp = 0,0 em 10 000 vetores; só o UUID
  aleatório de `graph.name` mudava os bytes. Agora é normalizado → bytes reprodutíveis.

## 7. Inferência no frontend e política de decisão

- Carregamento lazy; um `run()` em voo por vez; **descarte de resultados antigos** (troca de
  geração no `reset()`/timeout); timeout de 2 s; 3 falhas seguidas → status `error` (UI); NaN nunca
  vira score; validação de I/O no warmup; **sem fallback de modelo por CDN de terceiros**; WASM
  **servido do mesmo origin**: `?url` do Vite sobre o pacote instalado (versão sempre igual ao JS; sem
  CDN, offline) e entry `onnxruntime-web/wasm` (o bundle padrão pedia a variante WebGPU/jsep, achado do
  teste em navegador real).
- Throttle de 200 ms **mantido**: o custo por inferência medido é ≪ 1 ms (abaixo) e a janela de
  features só muda a ~10 Hz; diminuir o intervalo não traz informação nova. O limite real é o
  `ML_STALE_MS` (1,5 s).
- **Política (decisão de 2026-09-19):** regra de alarme sempre dispara. ML ≥ 0,85 gera `ML_WARNING`.
  ML ≥ 0,95 só vira `ML_ALARM` se houver uma **regra de aviso fisiológica** ativa (PERCLOS,
  fechamento prolongado, tendência de EAR, piscadas lentas, bocejo, queda de cabeça; `FACE_LOST`
  não conta). Sem corroboração, o ML limita-se a `WARNING`. *Antes*, ML ≥ 0,95 sozinho, com olhos
  abertos, levava a `ALARM` (provado por teste vermelho). Esta política é uma escolha de projeto
  para um modelo não validado, **não** foi otimizada com dados.
- Os modos `ml` e `hybrid` são hoje **equivalentes** (regras + ML); `ml` não significa “só ML”.
- Caracterização (não corrigido, é falha-segura): o *cooldown* de microsleep não bloqueia
  re-alarme — após `ackAlarm()` com olhos ainda fechados o alarme volta imediatamente.

## 8. Calibração

Altera **somente as regras**: limiar de EAR (mediana aberto/fechado, com clamp 0,12–0,45), baseline
de EAR (tendência) e baseline de nose-drop (head-drop). **Não** altera as features do ML (o EAR
entra cru), **não** altera o modelo e **não** altera os limiares do ML. Efeito indireto: durante a
calibração os frames viram rótulos 0/1 do modelo do usuário. Persistência em
`safenap_calibration_v3` (localStorage); mínimo 20 amostras/fase; timeout 12 s/fase; sugere
recalibrar após 6 h; "pular" usa limiar 0,25.

## 9. Performance (o que foi e o que não foi medido)

| Item | Resultado |
|---|---|
| Inferência ORT-web (WASM) do modelo embarcado, **em Node 26.4 nesta máquina**, n=1000, 18 features | p50 0,041 ms · p95 0,069 ms · p99 0,264 ms · máx 2,1 ms |
| ORT-web **no Chromium** (Playwright, servidor de dev, WASM local, sem requisição externa do ORT): status `ready`, score = ORT Python (diferença 0) em 12 vetores; latência p50 ≈ 4,9 ms **incluindo** o polling de 1 ms do harness (limite superior, não custo real) |
| MediaPipe FPS / latência, extração de features, CPU, memória | **Não medido.** O loop é `setTimeout(100 ms)` ⇒ teto de ~10 FPS por construção; o FPS real depende do `detectForVideo`. |
| Regras de detecção | `reports/latency/frontend_processing.json` (não inclui ORT nem MediaPipe) |

Nenhuma otimização foi feita; o comportamento funcional foi preservado.

## 10. Reproduzir

Ambiente: Python 3.14 + `ml/requirements.lock.txt` (versões exatas usadas nesta auditoria); Node
para o frontend.

```bash
# (a) reproduz o ONNX SINTÉTICO embarcado (byte a byte com as mesmas versões)
cd ml && python scripts/generate_realistic_model.py

# (b) pipeline REAL — precisa dos datasets (baixados manualmente; NÃO disponíveis neste ambiente)
python scripts/build_manifest.py uta --raw ../data/raw/uta --dry-run                         # 1º: só olhar o layout
python scripts/build_manifest.py uta --raw ../data/raw/uta --out ../data/manifests/uta.csv \n    --confirm-labels uta_rldd/v1 --dataset-version "<versão>"                                # ver §13 e DATASET_PIPELINE.md
python scripts/extract_features.py --raw ../data/raw/uta --manifest ../data/manifests/uta.csv \
    --landmarker ../frontend/public/mediapipe/models/face_landmarker.task --out ../data/features/uta.csv
python scripts/train_model.py --data ../data/features/uta.csv --out-dir ../reports/ml/uta_run1 \
    --seed 42 --dataset-name "UTA-RLDD (0 vs 10)"
python scripts/evaluate.py --model artifacts/run1/drowsiness.onnx --data <csv de sujeitos de teste>
python scripts/train_model.py ... --deploy ../frontend/public/models   # só depois de revisar metrics.json

# fixtures de paridade (só quando schema/geometria/modelo mudarem de propósito)
python scripts/make_golden_fixture.py

# testes
cd ml && python -m pytest tests          # 41
cd frontend && npx vitest run && npx tsc -b   # 212
```

**Outra pessoa reproduz o treinamento?** O *pipeline* sim: com o mesmo CSV, seed e versões o ONNX
sai idêntico (testado). O *treinamento real* não, ainda: os datasets NTHU/UTA não estão no
repositório (licença/aprovação), o manifesto de rótulos depende da decisão de mapeamento, e o
`face_landmarker.task` precisa ser o mesmo do frontend. Sem isso, só o modelo sintético é reproduzível.

## 11. Lacunas conhecidas (não corrigidas)

- Modelo do usuário: pseudo-rótulos vêm do ONNX sintético; treino com `Math.random` (sem seed),
  sem holdout; 500 amostras/classe ≈ 50 s a 10 fps (autocorrelacionadas); a fase "olhos fechados" da
  calibração ensina "olho fechado = sonolento". Prioridade sobre o ONNX **mantida** (decisão de
  produto pendente). A política do §7 vale para o score de ambos.
- Pesos da fusão multi-sinal e rampas 0,7–0,95 não têm justificativa empírica.
- `download_datasets.py` não baixa nada automaticamente (IDs `FILL_ME`).
- **Integridade do ONNX em runtime:** o hash do model card só é conferido em testes; o navegador
  não verifica o sha256 antes de `InferenceSession.create`.
- Sem CSP no app (o WASM do ORT já é do mesmo origin; as fontes do Google no CSS ainda são de terceiros).
- Um `run()` do ORT que trava desativa o ONNX na sessão (mantém `inFlight`, sem `run()` concorrente)
  e o status vira `error`; não há recriação automática da sessão. O warmup não tem timeout.
- ONNX e modelo do usuário compartilham o buffer de suavização (autocorrige em 3 amostras).
- `SCHEMA_HASH` cobre só a ordem das features, não sentinela/janela/landmarks (esses são cobertos
  pelos testes de paridade dourada).

### Revisões (2026-09-19)

`code-reviewer` (sem CRÍTICO/ALTO) e `security-reviewer` (sem CRÍTICO) rodaram sobre estas
mudanças. Corrigidos a partir deles: validação estrutural de modelo remoto/persistido
(`validateUserRF`; antes um par malicioso via sync podia causar NaN, estouro de pilha ou fixar
"alerta"), amostras com NaN/Infinity, chaves de localStorage `v2` (dados `v1` usavam 0 em vez de -1
para "sem piscada"), timeout de inferência agora reporta `error`, `ML_ALARM` via fusão exige regra de
aviso, manifesto restrito a `--raw` e `evaluate.py --model-card` recusa sujeitos do treino.

## 12. Modelo do usuário fora do caminho de segurança (2026-09-20)

Achado: o RF do usuário era treinado em sessão (a cada 30 s, pseudo-rótulos do ONNX sintético, sem holdout)
e tinha prioridade sobre o ONNX na inferência — o modelo de segurança mudava durante a condução.
Correção: `isUserModelEnabled()` (`frontend/src/ml/thresholds.ts`, `VITE_ENABLE_USER_MODEL`, padrão desligado).
Desligado: `drowsinessModel.inferAsync` ignora o modelo do usuário e `mlDataCollector.start()` não agenda o
auto-treino. A infraestrutura (coleta, treino manual, sync) continua disponível para experimentação.
Testes: `drowsinessModel.test.ts` (ignorado por padrão / prioridade só no modo experimental), `mlDataCollector.test.ts`.

## 13. Pipeline pronto para dataset real (preparado, NÃO executado)

> **Pipeline preparado, mas a validação de sonolência ainda não foi executada por ausência de dataset
> real rotulado.** Nenhum treino com dado real, nenhuma métrica de sonolência e nenhum dado sintético
> apresentado como validação existem neste repositório.

### 13.1 Quatro tipos de validação (não misturar)

| Tipo | O que responde | Estado |
|---|---|---|
| **Software** | O código faz o que a especificação diz? (testes unitários, paridade Python↔TS, Python↔ONNX, integração, build) | Feito e automatizado (Vitest 219, pytest 96, `tsc -b`, build) |
| **Visão** | O EAR/landmarks distinguem olho aberto de fechado em pessoas reais? | Feito **só para estado do olho**, no CEW (`reports/ear_validation/`). **Não** é validação de sonolência. |
| **Modelo de drowsiness** | O classificador separa sonolento de alerta em pessoas que ele nunca viu? | **Não executado.** Exige dataset com rótulo de sonolência (UTA-RLDD / NTHU-DDD). |
| **Condições reais** | Funciona com condutores reais, em direção real, com o hardware? | **Não realizado.** |

O ONNX embarcado continua **EXPERIMENTAL** (treinado só em dados sintéticos; `metrics: null`; ver §6).

> **Detalhe operacional, auditoria dos adaptadores, integridade e procedimento de 17 passos: `docs/DATASET_PIPELINE.md`.**

### 13.2 Do vídeo ao modelo

```
dataset real → build_manifest.py (adaptador por dataset) → manifest.csv (video,subject_id,label,source_label,...)
  → extract_features.py (FaceLandmarker tasks, 18 features, estado NOVO por vídeo) → features.csv
  → train_model.py (holdout por sujeito + GroupKFold no treino; RF/…; ONNX; paridade sklearn↔ORT)
  → reports/ml/<run>/{model_card,metrics,experiment}.json + confusion_matrix.csv + drowsiness.onnx
```

Adaptadores em `ml/dataset_adapters/` (um por dataset, sem parser genérico):

| Dataset | Sujeito | Vídeo/sessão | Rótulo | Quadro |
|---|---|---|---|---|
| UTA-RLDD (`uta_rldd.py`) | pasta-pai do vídeo | 1 vídeo por (sujeito, classe); `video_id` = caminho relativo | nome do arquivo (0/5/10) | não há rótulo por quadro: o vídeo inteiro herda a classe |
| NTHU-DDD (`nthu_ddd.py`) | informado na tabela de pares | 1 vídeo com vários segmentos | arquivo de anotação por quadro | `--fps` obrigatório converte quadro → segundo |

**A estrutura de pastas/anotações acima é SUPOSIÇÃO documentada, não verificada** (este ambiente não tem os
datasets). Se os arquivos reais forem diferentes, os adaptadores **falham com erro claro**
(`DatasetLayoutError`) em vez de adivinhar; ajuste-os depois de inspecionar o download. O layout antigo de
`download_datasets.py` (`awake/low/high`, `Video/Evaluation`) não é usado.

### 13.3 Rótulo do dataset → rótulo SafeNap (explícito, sem conversão silenciosa)

> Todos os mapeamentos de **inclusão** abaixo são `UNVERIFIED` (vêm da descrição publicada dos datasets, não
> conferida aqui) e só entram no manifesto com `--confirm-labels <id-do-mapa>`, depois de ler a documentação
> oficial. "Equivalência direta" significa *pretendida*, não *comprovada*. Ver `DATASET_PIPELINE.md` §3.

| Dataset | Rótulo original | SafeNap | Justificativa |
|---|---|---|---|
| UTA-RLDD | `0` (alerta) | 0 alerta | equivalência direta |
| UTA-RLDD | `10` (sonolento) | 1 sonolento | equivalência direta |
| UTA-RLDD | `5` (baixa vigilância) | **EXCLUÍDO** | intermediário: como "alerta" ensinaria que sonolência leve é normal; como "sonolento" inflaria a classe positiva. Contado em `excluded_by_source_label` |
| NTHU-DDD | `0` (não sonolento) | 0 alerta | equivalência direta (formato do arquivo assumido) |
| NTHU-DDD | `1` (sonolento) | 1 sonolento | idem |
| NTHU-DDD | anotações de olhos/boca/cabeça | **não usadas** | são outras tarefas, não rótulo de sonolência |

Ressalvas de rótulo: no UTA o rótulo é por vídeo inteiro (~10 min), não por instante — trechos desperto
dentro de um vídeo "10" viram ruído de rótulo. Diferenças de aquisição (câmera, luz, óculos) entre datasets
significam que desempenho em um não transfere automaticamente para o motorista real.

### 13.4 Unidade de avaliação (dita em cada métrica)

- **window** (`holdout_test`, `cv_train_subjects`): cada linha do CSV = 18 features de uma janela de ~1 s
  terminada num quadro. Janelas vizinhas são quase idênticas → o tamanho de amostra *efetivo* é o número de
  vídeos/sujeitos, não o de linhas; ler intervalos de confiança com isso em mente.
- **clip** (`holdout_test_clip_level`): par `(video_id, label)`; probabilidade média das janelas ≥ limiar →
  decisão do clipe. Só é calculada com ≥ 2 clipes de teste por classe; senão sai `available: false` + motivo.
  Vídeo "inteiro" com um único rótulo (UTA) é um clipe; um vídeo NTHU com segmentos vira um clipe por rótulo.
- **subject**: **não** calculada (exigiria agregar por pessoa e há poucos sujeitos por classe). O número de
  sujeitos de teste é reportado em `split.test.subjects`.

Métricas produzidas quando aplicáveis: accuracy, balanced accuracy, precision, recall/sensibilidade,
especificidade, F1, matriz de confusão, ROC-AUC, PR-AUC (`ml/evaluation/metrics.py`); AUCs ficam `null` se
o teste só tiver uma classe. Registrados junto: sujeitos, vídeos, clipes, linhas, positivos/negativos por
partição.

### 13.5 Split e vazamento

`train ∩ test = ∅` e, em cada fold do GroupKFold, `treino(fold) ∩ validação(fold) = ∅` (validação =
out-of-fold agrupado por sujeito, só sobre os sujeitos de treino, portanto também disjunta do teste).
`assert_disjoint` aborta o treino com `ValueError("vazamento de grupos…")`; testes em
`ml/tests/test_train_pipeline.py`. `evaluate.py` recusa CSVs com sujeitos de treino (model card).
Se um dataset tiver a mesma pessoa sob `subject_id` diferentes (ex.: sessões), o split **não** detecta isso:
o `subject_id` do manifesto precisa identificar a *pessoa*.

### 13.6 Relatório reproduzível (`--out-dir`, convenção `reports/ml/<run>/`)

`experiment.json` (dataset+sha256, seed, config, candidatos, split com contagens/IDs, features,
`schema_hash`, `model_version`, versões das bibliotecas, timestamp), `metrics.json` (com
`evaluation_units`), `model_card.json`, `confusion_matrix.csv`, `drowsiness.onnx`.
`model_version = <modelo>-<schema_hash[:8]>-<sha256 do CSV[:8]>-s<seed>`. Mesmo CSV + config + seed +
versões ⇒ mesmos bytes de ONNX (testado). O relatório responde "de onde saiu essa métrica?"; **não** prova
desempenho em condutores reais.

### 13.7 O que continua fora de escopo

Agregação por **pessoa**; calibração individual do limiar de EAR offline (o offline usa 0,21 fixo, ver
`extract_features.py`); intervalos de confiança / bootstrap por sujeito; implantação automática de modelo
treinado (`--deploy` é manual e o card sai `EXPERIMENTAL`).
