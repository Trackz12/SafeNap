# Relatórios empíricos do SafeNap

Esta pasta reúne evidência **real e reproduzível** — medida ou calculada por
scripts versionados — para sustentar as afirmações quantitativas do artigo,
em resposta direta aos pontos 4 e 5 do parecer do orientador (metodologia
pouco detalhada, alegações qualitativas sem número).

## `latency/` — latência do pipeline, decomposta por etapa

Nenhum número aqui é estimado de memória. Cada linha do
[`latency/summary.md`](latency/summary.md) é medida (com script) ou
calculada (com fórmula), e cada uma é rotulada como tal.

| Arquivo | O que é |
|---|---|
| `summary.md` | Tabela consolidada, com o que falta medir explicitado |
| `backend_processing.{json,md}` | `SafetyManager`/`GripMonitor`, medido (`backend/scripts/measure_latency.py`) |
| `ws_roundtrip.{json,md}` | WebSocket ida-e-volta, medido com o backend real rodando (`backend/scripts/measure_ws_roundtrip.py`) |
| `frontend_processing.json` | Regras de detecção no navegador, medido (`npx vitest bench src/detection/latency.bench.ts`, roda no frontend) |
| `serial_transmission_calc.md` | Transmissão serial USB, **calculado** (fórmula 8N1 @ 9600 bps) — não medido, sem hardware físico neste ambiente |

**Não medido, e por quê**: extração de landmarks pelo MediaPipe (roda no
navegador do usuário, depende do hardware dele) e a rede real de um veículo
em movimento (Tailscale/Wi-Fi) — ver a seção "O que isso NÃO prova" em
`summary.md`.

## `detection_scenarios/` — bateria de cenários sintéticos

[`scenarios.md`](detection_scenarios/scenarios.md): 15 cenários rodados
contra o `DetectionEngine` real (não uma reimplementação), com verdade-
fundamental atribuída a partir das faixas fisiológicas já documentadas em
`docs/DETECTION.md` (duração de piscada, PERCLOS, micro-sono etc.). Gera
matriz de confusão binária (alerta vs. sem alerta) com precisão/recall/F1
reais. Reproduza com `cd frontend && npx vitest run src/detection/detectionEngine.scenarios.test.ts`.

**Leia a ressalva no topo do arquivo de teste antes de citar isso no
artigo**: isso valida que o código faz o que a especificação diz (verificação
de engenharia), **não** que os limiares escolhidos correspondem à sonolência
real de uma pessoa (validação empírica) — essa segunda parte segue como
trabalho futuro.

## `ear_validation/` — EAR contra dados humanos reais (CEW) ✅ concluído

A lacuna do item anterior foi fechada: validamos a classificação olho-
aberto/fechado por EAR contra o **CEW (Closed Eyes in the Wild, NUAA)** —
2423 pessoas reais (1192 com olhos fechados, 1231 abertos), fotos de rosto
inteiro. Ver [`ear_validation/cew_results.md`](ear_validation/cew_results.md).

**Como foi resolvido o bloqueio anterior** (RAR sem `unrar`/7-Zip instalado):
usamos `node-unrar-js` — o unrar oficial compilado para WASM, distribuído
via npm — em vez de baixar um executável de terceiro. Isso ficou só no
scratchpad da sessão, não entrou no repositório (a licença do CEW proíbe
redistribuição, e o repositório é público).

**Resultado real** (`ml/scripts/validate_ear_against_cew.py`, réplica em
Python da mesma fórmula de EAR do frontend, MediaPipe FaceLandmarker —
mesmo modelo `.task` usado no navegador):

| Limiar | Acurácia | Precisão | Recall | F1 |
|---|---|---|---|---|
| 0,21 (calibrado, da bateria sintética) | 0,905 | 0,840 | 0,993 | 0,910 |
| 0,25 (default da literatura) | 0,820 | 0,731 | 0,997 | 0,844 |

**Leitura honesta**: recall é excelente (>99% — o sistema quase não deixa de
detectar um olho realmente fechado, o que importa mais para segurança).
Precisão é mais baixa (~84% no limiar calibrado) — com um limiar **fixo**
igual para todo mundo, ~16% dos "fechados" detectados são na verdade olhos
abertos de pessoas com formato de olho diferente da média. Isso **confirma
empiricamente por que a calibração por pessoa (já implementada em
produção) importa**: um limiar único para todo mundo é o cenário mais
pessimista, não o que o usuário real experimenta.

32 imagens (closed) e 4 (open) não tiveram rosto detectado pelo MediaPipe —
excluídas da matriz, reportadas separadamente (limitação do detector na
resolução 100×100 do dataset, não do cálculo de EAR em si).

**Achado colateral**: `ml/scripts/extract_features.py` (pipeline de treino do
modelo ONNX) usa a API antiga `mediapipe.solutions.face_mesh`, que **não
existe mais** em nenhuma versão do mediapipe instalável neste Python
(3.14) — teve que ser reescrito para a API `mediapipe.tasks.vision.FaceLandmarker`
neste script novo. Vale atualizar o pipeline de treino também, mas ficou
fora do escopo desta rodada.
