# Engine de Detecção (Detection Engine)

## Arquitetura (refatorada em 2026-09-23 — auditoria completa em `.ai/memory.md`)

`DetectionEngine` é hoje um **orquestrador fino**, não mais uma classe de
~900 linhas fazendo tudo. Cada sinal tem um módulo dedicado, testável
isoladamente (com relógio injetável — `temporal/clock.ts` — em vez de
`Date.now()` espalhado):

```
frontend/src/detection/
├── detectionEngine.ts        orquestrador: liga os detectores, aplica a
│                              histerese de entrada/saída de estado
│                              (depende do estado anterior — não é
│                              responsabilidade de nenhum detector nem da
│                              fusão), publica métricas e efeitos colaterais
├── eye/
│   ├── eyeStateDetector.ts    OPEN/CLOSING/CLOSED/OPENING/UNKNOWN
│   ├── blinkDetector.ts       classifica piscada normal/lenta, taxa por minuto
│   ├── perclosTracker.ts      PERCLOS com denominador de tempo VÁLIDO observado
│   └── microsleepDetector.ts  fechamento agudo+sustentado, com cooldown
├── head/headDropDetector.ts   queda de cabeça, com corroboração ocular
├── mouth/yawnDetector.ts      bocejo
├── temporal/
│   ├── clock.ts               Clock injetável (SystemClock + FakeClock p/ testes)
│   └── earTrendTracker.ts     tendência de declínio do EAR (fase prodrômica)
├── vision/visionQuality.ts    GOOD/DEGRADED/LOST — integrado ao pipeline e
│                              publicado em DetectionMetrics.visionQuality
└── fusion/signalFusion.ts     fonte ÚNICA de evidência→decisão (ver abaixo)
```

**Antes**: existiam DOIS mecanismos de decisão coexistindo —
`DetectionEngine.evaluate()` decidia por uma cadeia if/else de prioridade
fixa (chamando `ml/mlReasons.ts`), e só quando ela não decidia nada é que
`signalFusion.ts` (scoring contínuo) entrava como fallback. **Depois**: um
único módulo (`fusion/signalFusion.ts`) com 3 camadas explícitas:

1. **Indicadores fortes** (gatilho determinístico, prioridade fixa —
   preservada da cadeia original, não redecidida): MICROSLEEP,
   EYES_CLOSED_DURATION, PERCLOS_CRITICAL (alarme); PERCLOS, YAWN,
   HEAD_DROP, FACE_LOST, PROLONGED_CLOSE, EAR_TREND, SLOW_BLINKS (aviso).
2. **ML corroborativo**: nunca origina ALARM sozinho — só escala para
   ML_ALARM quando há uma regra de aviso fisiológica ativa (FACE_LOST não
   conta como corroboração).
3. **Suporte (fallback contínuo)**: quando nenhum indicador forte disparou
   sozinho, sinais fracos (bocejo leve, cabeça caindo, tendência de EAR,
   PERCLOS moderado, ML) somam evidência ponderada em vez de competir.

O resultado (`FusionResult`) é explicável: `primaryReason` (o que
disparou) + `contributingSignals` (todos os sinais ativos no frame, não só
o vencedor) — pensado para debug, UI e logs, não só a decisão binária.

**Mudança de comportamento deliberada** (única desta refatoração; tudo o
resto preserva o comportamento anterior byte a byte, verificado pelos 227
testes de ponta-a-ponta que já existiam): o **PERCLOS agora usa tempo
VÁLIDO observado como denominador**, não mais uma janela de relógio fixa de
60s. Perda de rosto (oclusão, GPU engasgando, olhar pro retrovisor) reduz o
denominador em vez de silenciosamente contar como "olhos abertos" — ver
`eye/perclosTracker.ts` para o racional completo e o teste que documenta
ANTES/DEPOIS.

## Auditoria de qualidade de detecção (2026-09-23)

Uma segunda auditoria, focada em **falso positivo / falso negativo** em vez de
arquitetura, encontrou seis defeitos. Todos corrigidos; os quatro primeiros
mudam comportamento observável e estão documentados com ANTES/DEPOIS no
código e em testes dedicados.

| # | Achado | Efeito | Correção |
|---|--------|--------|----------|
| 1 | `vision/mediapipe.ts` **descartava silenciosamente** o quadro quando o MediaPipe achava rosto mas `analyzeFrame` rejeitava a geometria — nem `processFrame` nem `processNoFace` eram chamados | FN (tempo não observado entrava no denominador do PERCLOS) **e FP** (`closedSince`/candidato a micro-sono sobreviviam ao intervalo ⇒ ao voltar um quadro válido, `closedForMs` incluía o buraco inteiro ⇒ alarme falso) | rotear para `processNoFace('DEGRADED')` |
| 2 | confirmação de fechamento por **contagem de quadros** (`closeConfirmFrames`) enquanto o laço real rodava a **8 FPS medidos** ⇒ "3 quadros" ≈ 375 ms | FN sistemático: piscada de 200 ms nunca confirmava ⇒ `blinkRate` ≈ 0, nada entrava no PERCLOS, feature de ML inútil. Comportamento mudava com o FPS da máquina | `closeConfirmMs` (tempo) + `closeConfirmMinFrames` (piso de ruído) |
| 3 | `validObservedMs = windowMs - lostMs` assumia a janela inteira observada desde o 1º quadro | FN: aos 5 s de sessão com 4 s de olho fechado o PERCLOS reportava 6,7% em vez de 80%; `confidence` era calculada e **nunca consumida** | denominador cresce com a sessão; `sufficient` gate consumido por `FusionInputs.perclosValid` |
| 4 | `microsleepWarnMs` e `earTrendAlarmFraction` existiam nos 3 presets e **nunca eram lidos** | falsa promessa arquitetural | removidos (ver *Configuração removida*) |
| 5 | `YawnDetector.active` só caía no ramo "boca fechada" e só após `cooldownMs` | FP: 10 s de WARNING por abertura de 400 ms; com a boca continuamente aberta (falar/rir/cantar) `active` **nunca caía** | `maxMs` + `activeHoldMs`; `cooldownMs` passa a ser guarda de re-disparo |
| 6 | classificação de piscada devolvia `null` para a zona-morta 400–550 ms | lacuna silenciosa | `BlinkKind` explícito: `artifact`/`normal`/`indeterminate`/`slow`/`prolonged` (nenhuma decisão mudou) |

### Configuração removida (achado nº 4)

`microsleepWarnMs` e `earTrendAlarmFraction` foram **removidos**, não
implementados. Racional:

- **`microsleepWarnMs`** (900/800/600 ms): um fechamento em nível de micro-sono
  com essa duração **já** dispara `PROLONGED_CLOSE` via `warnCloseMs`
  (500–800 ms). Um estágio de WARNING dedicado a micro-sono seria redundante
  com um caminho de alerta que já existe e funciona.
- **`earTrendAlarmFraction`**: a preferência de projeto é que a tendência de EAR
  seja evidência de fadiga progressiva e **nunca** gere ALARM sozinha. O código
  já se comportava assim (a constante nunca era lida). Implementá-la
  contrariaria a política; mantê-la sem uso prometia um comportamento
  inexistente.

### Independência de FPS (§14)

Fenômenos temporais medidos em **tempo**: duração de fechamento, micro-sono,
bocejo, queda de cabeça, piscada lenta, janelas de PERCLOS e de taxa.
Quadros permanecem **só** como piso de ruído (`CONFIRM_MIN_FRAMES = 2`,
mediana-3 do EAR, `EAR_TREND_MIN_SAMPLES`). A bateria
`detectionEngine.robustness.test.ts` roda os mesmos roteiros a 10, 30 e 60 FPS
e verifica que piscadas são contadas e que a latência até o ALARM não varia
por ordem de grandeza.

### Cadência do laço de detecção (2026-09-24)

O próximo passo recomendado pela auditoria era elevar o FPS, porque um período
de amostragem longo impõe um **teto de resolução temporal** a todos os
fenômenos oculares — que agora são medidos em ms, mas não podem ser observados
com granularidade melhor que o período do laço.

**Medido em navegador real** (`frontend/tests/e2e/detection-rate.spec.ts`, que
ativa a câmera e lê a instrumentação do app):

| | Cadência medida | Período |
|---|---|---|
| Antes (`setTimeout(100 ms)` fixo + `requestAnimationFrame`) | **8 FPS** | ~125 ms |
| Depois (orçamento de quadro adaptativo) | **30 FPS** | ~33 ms |

Os dois números são medição, não estimativa: o valor "antes" foi obtido
revertendo o trecho e rodando o mesmo teste. O teste é guarda de regressão —
falha se a cadência voltar ao patamar antigo.

O custo por quadro do passo de detecção (MediaPipe + EAR + regras) medido na
mesma condição foi de **~5 ms**, mas esse valor é um **piso inferior**: a câmera
sintética do mock não contém rosto humano (o teste afirma isso explicitamente),
então o estágio de refinamento de landmarks do MediaPipe não executa. **Não
citar esse número como "o custo do MediaPipe" sem a ressalva.** Medir o custo
com rosto real exige vídeo humano e fica como validação de campo. O custo do
último passo também é exposto no `title` do badge de FPS da interface, para
diagnóstico rápido em máquina desconhecida no dia da demonstração.

O laço agora espera **o que resta** do orçamento de quadro (`TARGET_FRAME_MS`,
33 ms) depois da detecção, em vez de somar uma espera fixa ao custo do
trabalho. Dois pisos protegem a interface: `MIN_LOOP_DELAY_MS` (8 ms) e um teto
de ciclo de trabalho (`MAX_DUTY_CYCLE`, 0,5 — a espera nunca é menor que o
tempo gasto detectando). Numa máquina lenta a cadência cai sozinha em vez de
travar a página. O `requestAnimationFrame` saiu do caminho de agendamento: ele
adicionava até ~17 ms de jitter e fazia a detecção **parar por completo** quando
a aba não estava pintando.

**Contador de FPS da interface corrigido.** Ele media `requestAnimationFrame`,
isto é a taxa de RENDER do navegador (~60), e exibia isso rotulado como "FPS" ao
lado do vídeo. Era um número verdadeiro sobre a coisa errada: quem lesse
"60 FPS" concluiria que o sistema analisa 60 quadros por segundo, quando a
detecção rodava a 8. Agora vem de `mediaPipeManager.getDetectionFps()`.

**Acoplamento corrigido junto (senão o aumento de FPS seria uma regressão):** as
janelas do EAR trend eram contagens de amostra (20 mínimas / 10 recentes). A
30 FPS as mesmas 20 amostras valeriam 0,67 s em vez de ~2,5 s, e `EAR_TREND` —
que é **regra forte** de WARNING — ficaria 3,75x mais sensível sem ninguém ter
decidido isso. Convertidas para ms (`EAR_TREND_MIN_OBSERVATION_MS` = 2000,
`EAR_TREND_RECENT_WINDOW_MS` = 1000), com `EAR_TREND_MIN_SAMPLES` reduzido a 8 e
rebaixado ao papel de piso de ruído.

**Acoplamento corrigido em 2026-09-24:** o buffer do `featureExtractor` era de
10 QUADROS, então a janela das features de ML caiu de ~1,25 s (a 8 FPS) para
~0,33 s (a 30 FPS). Três features mudavam de significado junto:
`earTrendPerSec` e `mouthTrendPerSec` passavam a extrapolar uma taxa **por
segundo** a partir de um terço de segundo, e `earStdDev` media o desvio de um
trecho muito menor do mesmo fenômeno. A janela agora é definida em tempo
(`windowMs` = 1200 ms no `shared/feature_schema.json`, fonte única de verdade
dos dois lados); `bufferSize` virou apenas teto de memória e `minFrames` piso de
ruído. `shared/feature_golden.json` foi regenerado e a paridade Python↔TS
verificada. O `drowsiness.onnx` e seu model card **não** registram a janela,
então o artefato não precisou ser regerado.

Testes que travam isso: o mesmo fenômeno (queda de EAR tardia, não linear) tem
que produzir `earTrendPerSec` e `earStdDev` equivalentes a 8 e a 30 FPS
(`featureExtractor.test.ts`). Um declínio *linear* não serve para esse teste —
a inclinação de uma reta é a mesma em qualquer sub-janela —, por isso o cenário
é deliberadamente não linear.

### O ML saiu do caminho de decisão (2026-09-24)

Pergunta que motivou a medição: *"essa parte do ML pode estar mais atrapalhando
do que ajudando?"*. A resposta, medida, é **sim** — e o padrão passou de
`hybrid` para **`rules`**.

Sonda reproduzível: `ml/scripts/probe_ml_false_positives.py` → `reports/ml_probe/`.
Sobre **20.736 estados INEQUIVOCAMENTE acordados** (`perclos <= 0,08`,
`earTrendPerSec >= -0,01`, `earStdDev <= 0,035` — definição estrita, para o
resultado não ser contaminado por estados que já são sonolência):

| Limiar | Efeito ao cruzar | Estados acordados que cruzam |
|---|---|---|
| `>= 0,70` | passa a somar no score contínuo de fusão | **33,3%** |
| `>= 0,85` | gera `ML_WARNING` **sozinho**, sem regra fisiológica | **16,7%** |
| `>= 0,95` | nível de `ML_ALARM` (ainda exige corroboração) | 0% |

Pior caso acordado: `P(drowsy) = 0,894` — acima do limiar de WARNING — para
alguém com EAR absoluto 0,13, piscando 6/min e **PERCLOS zero**.

**Causa raiz:** as regras comparam o EAR ao **limiar calibrado da pessoa**; as
features do ML usam **EAR absoluto**. Isolando só o EAR, com o resto
canonicamente acordado:

```
ear 0,35 -> P=0,392      ear 0,20 -> P=0,666
ear 0,30 -> P=0,392      ear 0,14 -> P=0,666
ear 0,24 -> P=0,535      ear 0,12 -> P=0,666
```

Ou seja: **a calibração — defesa central do projeto contra variação entre
pessoas — não protege o caminho de ML.** Uma pessoa de olhos naturalmente
estreitos é "sonolenta" para o modelo por construção. Soma-se a isso um viés
constante de ~+0,39 causado pelo `noseDropRatio`: o gerador sintético treinou
com a faixa 0,0–0,08 e o frontend calibrado opera em torno de 0,30.

**E não havia benefício compensando.** Para sonolência real o score satura em
1,000 — mas nesses casos as regras fortes (PERCLOS, EYES_CLOSED_DURATION,
MICROSLEEP) já dispararam. O ML não adicionava detecção, apenas superfície de
falso positivo.

**Dois agravantes encontrados junto:** (a) `detectionMode` era `hybrid` por
padrão e **nada no app chamava `setMode()`** — o caminho estava permanentemente
ligado, sem forma de desligar; (b) quando o score cruza 0,85 a fusão
**sobrescreve** a razão (`warnedReason = 'ML_WARNING'`), então a UI mostrava
`ML_WARNING` em vez de `PERCLOS`/`PROLONGED_CLOSE` — perda de explicabilidade
justamente no alerta. O item (b) **não foi corrigido**: com `hybrid` agora sendo
opt-in, ele só afeta quem pedir explicitamente esse modo. Fica registrado.

**O que continua funcionando:** o ONNX segue sendo inferido e publicado em
`DetectionMetrics.mlScore` como leitura experimental visível; `fuseSignals` o
ignora e ele não bloqueia mais a liberação de ALARM. O modo `hybrid` continua
disponível via `setMode()`, e a bateria de testes da política híbrida continua
rodando (agora pedindo o modo explicitamente).

**Para reverter:** trocar o padrão de volta para `hybrid` em
`detectionEngine.ts`. Antes de reverter, rodar a sonda de novo — se o modelo for
retreinado com dado real, os números acima mudam e a decisão deve ser
reavaliada com eles, não com estes.

### Espelho Python

`ml/features/blink.py` (usado para gerar as features de treino) foi atualizado
junto e `shared/feature_golden.json` regenerado. Sem isso, `perclos`,
`blinkRate` e `msSinceLastBlink` teriam semântica diferente no treino e na
inferência — exatamente o desvio treino↔inferência que aquele módulo existe
para evitar. A paridade é verificada por `frontend/src/ml/goldenParity.test.ts`
e `ml/tests/test_golden_parity.py`.

**Consequência para o modelo ONNX experimental — CORRIGIDO em 2026-09-24:**

A redação anterior desta seção dizia que o modelo "foi treinado com a semântica
ANTIGA de `perclos`/`blinkRate`" e por isso precisaria ser retreinado. **Isso
estava errado.** Verificação em `ml/scripts/generate_realistic_model.py`: o
modelo sintético nunca foi treinado com valores calculados pelo pipeline. Os
`perclos` e `blinkRate` de treino são **faixas uniformes escritas à mão**
(`rng.uniform(0.0, 0.10)` para alerta, `rng.uniform(0.25, 0.80)` para
sonolento). Portanto:

- **Não existe desvio treino↔inferência a corrigir por retreino** nessas duas
  features. Regerar o modelo sintético produziria o mesmo arquivo.
- O que de fato mudou é que o runtime passa a **atingir** essas faixas
  não-validadas sob condições reais um pouco diferentes. Isso é uma questão de
  calibração de faixas que nunca foram validadas — não se resolve treinando de
  novo sobre as mesmas faixas.

O motivo real e legítimo para retreinar continua existindo, mas é outro: o
modelo nunca viu dados humanos. Isso exige dataset rotulado real e está
bloqueado por acesso (ver *Datasets*).

**NEEDS VALIDATION** (parâmetros de engenharia sem base experimental —
sinalizados no código, não apresentados como "corretos"): o clamp do
threshold de calibração `[0.12, 0.45]` e o fator 0.5 (média simples) entre
EAR aberto/fechado; os pesos de `WEIGHTS` na fusão contínua
(`fusion/signalFusion.ts`); `closeConfirmMs` (60/90/150 ms);
`perclosMinObservationMs` (20 s); `yawnMaxMs` (7 s) e `yawnActiveHoldMs` (2 s);
o critério de `VisionQuality.DEGRADED` (hoje `|yawRatio| > 0.25`, o mesmo
limiar que `combineEyes` já usava para "confiar num olho só").

**Decisão explícita:** `VisionQuality` é **reportada, não usada para ponderar
decisão**. Rebaixar o peso de um sinal por causa do yaw exigiria um esquema de
pesos validado — inventar um seria apresentar como ciência o que é chute. O
que a qualidade de visão **faz** hoje: (a) `LOST`/`DEGRADED` mantêm o quadro
fora do denominador de observação válida do PERCLOS e do blink rate, e
(b) a UI distingue "Sem rosto" de "Ajuste a posição".

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
- Olhos só são marcados como fechados após **tempo contínuo abaixo do threshold** (`closeConfirmMs`: 150 ms no leve, 90 ms no padrão, 60 ms no alta) **e** um piso de 2 quadros consecutivos. O tempo é a unidade do fenômeno fisiológico; os quadros são só proteção contra ruído. Antes de 2026-09-23 a regra era contagem pura de quadros, o que na cadência medida de 8 FPS equivalia a ~375 ms no preset padrão e tornava piscadas de 200 ms **invisíveis** — ver *Auditoria de qualidade*, achado nº 2.
- Só reabrem quando `EAR > threshold × hysteresisFactor` (padrão 1.15) — evita flicker de estado quando o EAR oscila perto do limite.
- Cada segmento fechado é registrado (início/fim) para PERCLOS e contagem de piscadas (duração entre 50–400ms conta como piscada).

## PERCLOS — padrão da indústria

Proporção do tempo em que os olhos ficaram fechados dentro de uma janela deslizante de **60 segundos** (aproximação da métrica PERCLOS P80). É a base do escalonamento de severidade e muito mais robusta que avaliar apenas um episódio contínuo.

**Anti-falso-positivo:** segmentos com duração menor que `perclosIgnoreMs` (400ms — duração típica de uma piscada) são **excluídos do PERCLOS**. Piscadas normais continuam sendo contadas, mas não inflam a métrica de sonolência.

**Denominador = tempo VÁLIDO observado, não janela de relógio fixa** (desde 2026-09-23, ver `eye/perclosTracker.ts`). Antes, o denominador era sempre 60000ms de relógio, mesmo com boa parte da janela sem rosto observável (oclusão, GPU engasgando, olhar pro retrovisor) — esse tempo silenciosamente contava como "olhos abertos", diluindo o PERCLOS bem no momento em que a confiança no dado deveria cair.

Fórmula atual:

```
validObservedMs = min(60000, agora - inícioDaObservação) - tempoSemRostoNaJanela
perclos         = closedMs / validObservedMs
confidence      = validObservedMs / 60000
sufficient      = validObservedMs >= perclosMinObservationMs (20 s)
```

Duas correções distintas, ambas em direção de **falso negativo** antes:

1. **perda de rosto** sai do denominador em vez de contar como "olhos abertos";
2. **início de sessão** limita o denominador ao que de fato foi observado. Antes,
   aos 5 s de sessão com 4 s de olhos fechados, o resultado era `4000/60000 =
   6,7%` — um número baixo com aparência de medida válida. O PERCLOS era
   praticamente **inerte no primeiro minuto** (bater 25% exigia 15 s acumulados
   de fechamento).

**A confiança participa da decisão:** enquanto `sufficient === false`, o PERCLOS
é **ignorado por completo** pela fusão (`FusionInputs.perclosValid`) — não vira
regra forte, não soma no score contínuo, não aparece em `contributingSignals` e
não bloqueia a liberação de um ALARM. O valor continua sendo calculado e
publicado para gráfico/depuração. Antes, uma razão calculada sobre poucos
segundos tinha exatamente o mesmo peso de uma calculada sobre a janela cheia.

## Micro-sono (MICROSLEEP) — detector dedicado de evento agudo

O PERCLOS é uma métrica de **janela de 60s**: um micro-sono isolado de 1.5–3s fica diluído na média e demora a escalar a severidade. O detector de micro-sono reage ao **evento agudo** em tempo real:

- **Gatilho:** EAR < `threshold × microsleepThresholdFactor` (0.55 — olho *bem* fechado, não mero semi-fechado) sustentado por `microsleepAlarmMs` (600–2000ms conforme preset).
- **Confirmação:** exige um piso de 2 quadros consecutivos (`CONFIRM_MIN_FRAMES`) além da duração. Como `microsleepAlarmMs` (1500–2000 ms) corresponde a dezenas de quadros em qualquer cadência praticada, o piso de quadros nunca é a restrição decisiva aqui — é apenas coerência com o fechamento normal.
- **Cooldown** (`microsleepCooldownMs`, 8–12s): evita re-alarmar dentro da mesma onda de sonolência.
- **Prioridade máxima:** se micro-sono e outra razão disparam juntos, `MICROSLEEP` vence (é o sinal mais crítico).

Fisiologicamente, micro-sonos são os marcadores mais perigosos de sonolência ao volante: o motorista perde consciência por 1–3s sem perceber. Este detector cobre a faixa que ficava entre o "PROLONGED_CLOSE" (aviso) e o fechamento longo (alarme).

## Tendência de EAR (EAR_TREND) — fase prodrômica da sonolência

Sonolência real **evolui gradualmente**: a pálpebra desce aos poucos (fadiga muscular) antes de qualquer fechamento franco. A máquina de estados era puramente instantânea nisso — um motorista cujo EAR decai de 0.30 → 0.22 lentamente não disparava nada até cruzar o threshold.

- **Buffer de tendência:** amostras de EAR **suavizado** (filtro de mediana-3, o mesmo usado para fechamento) coletadas **apenas com olhos abertos** (piscadas não contaminam o declínio) numa janela de 60s (`longEarBuffer`).
- **Sinal:** fração de declínio da **média das últimas 10 amostras** suavizadas vs `baselineEar` calibrado. Se `(baseline - recent) / baseline > earTrendWarnFraction` (15–20% conforme preset), dispara WARNING `EAR_TREND`.
- **Requer calibração:** sem baseline calibrado não há tendência (retorna null — não dispara com o threshold padrão).
- **Tempo mínimo:** as amostras precisam cobrir `EAR_TREND_MIN_OBSERVATION_MS` (2000 ms) de relógio, mais um piso de 8 amostras. Em MILISSEGUNDOS desde 2026-09-24: eram 20 amostras, que valiam ~2,5 s a 8 FPS mas passariam a valer 0,67 s ao subir o laço para 30 FPS — o sinal ficaria 3,75x mais sensível sem ninguém ter decidido isso. A média "recente" também é temporal (`EAR_TREND_RECENT_WINDOW_MS`, 1000 ms) em vez de "as últimas 10 amostras".
- **Anti-falso-positivo:** a média das últimas 10 amostras suavizadas exige um declínio **sustentado** — um frame isolado de jitter (queda brusca de EAR por 1 frame, comum no MediaPipe) não consegue simular pálpebra caindo gradualmente.

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
| `YAWN` | boca aberta entre 400ms e `yawnMaxMs` (7s; abertura mais longa não é bocejo — é fala/riso/canto), persistindo `yawnActiveHoldMs` (2s) após fechar; `yawnCooldownMs` (10s) é o intervalo mínimo antes de um NOVO bocejo contar |
| `HEAD_DROP` | queda do nariz acima do baseline + margem por ≥ 2000ms **e** olhos não claramente alertas (EAR ≤ threshold×hysteresisFactor) no momento da confirmação — sem isso, olhar pro painel/celular com os olhos bem abertos bastava para disparar |
| `FACE_LOST` | rosto ausente por ≥ 5s |
| `PROLONGED_CLOSE` | olhos fechados ≥ 700ms |
| `EAR_TREND` | EAR médio caiu > 18% abaixo do baseline calibrado na última 1min (fase prodrômica — pálpebras pesando gradualmente; medido apenas com olhos abertos) |
| `SLOW_BLINKS` | ≥ 4 piscadas lentas (550ms–1800ms; a faixa 400–550ms é zona-morta, não conta como nada) por minuto — exige ≥ 30s de sessão antes de valer (evita taxa inflada no início) |

### → ALARM (razões)
| Razão | Condição (preset padrão) |
|-------|--------------------------|
| `MICROSLEEP` | olhos **bem fechados** (EAR < threshold × 0.55) sustentado por ≥ 1800ms, com cooldown de 10s — detector dedicado independente do PERCLOS, captura o evento agudo que a janela de 60s dilui |
| `EYES_CLOSED_DURATION` | olhos fechados continuamente ≥ 1500ms |
| `PERCLOS_CRITICAL` | PERCLOS ≥ 45% |

### Saída do ALARM
Requer olhos reabertos **E** PERCLOS < 15% (release level) — evita sair do alarme só por uma piscada rápida. Pode descer direto para WARNING se ainda houver sinal de aviso ativo.

### Saída do WARNING (histerese)
O WARNING não é liberado no primeiro frame abaixo do limiar: só sai do estado quando os sinais caem para uma **fração clara** (default 80%) dos níveis de entrada — PERCLOS < 20%, EAR_TREND < 14%, etc. Isso elimina o flicker NORMAL↔WARNING quando o sinal oscila na borda do limiar (ex: PERCLOS ~25%) sem perder sensibilidade de entrada.

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

> **Status: EXPERIMENTAL / NÃO VALIDADO.** O ONNX embarcado foi treinado **apenas em dados
> sintéticos** (não em NTHU/UTA-RLDD nem em pessoas reais). Não há métrica de desempenho de
> detecção de sonolência. Detalhes, evidências e limites: [`docs/ML_PIPELINE.md`](ML_PIPELINE.md).

O ML roda **100% no navegador** (`onnxruntime-web`, WASM) sobre as 18 features do `FeatureExtractor`.

```
FrameAnalysis → featureExtractor.extract() → FeatureVector (18 feats, ordem em shared/feature_schema.json)
                                                 ↓
                          drowsinessModel.inferAsync() → score P(DROWSY) ∈ [0,1]  (mediana de 3)
                                                 ↓
                          detectionEngine.evaluate() → regras + ML (política abaixo) → WARNING/ALARM
```

| Arquivo | Responsabilidade |
|---------|-----------------|
| `ml/featureOrder.ts` | Contrato das 18 features (espelha `shared/feature_schema.json`; testes de paridade) |
| `ml/thresholds.ts` | ML: WARNING=0,85, ALARM=0,95, RELEASE=0,70; throttle 200 ms; timeout 2 s |
| `ml/vectorToTensor.ts` | Único conversor FeatureVector → array/Float32Array (sentinela -1; NaN/Infinity → `null`) |
| `ml/drowsinessModel.ts` | Lazy load, 1 `run()` em voo, descarte de resultados antigos, timeout, status de erro |
| `ml/smoothing.ts` | Mediana do score |
| `ml/mlReasons.ts` | Política regras + ML |
| `ml/modelStatusStore.ts` | Status idle → loading → ready/error |

### Política de decisão (modos `rules` | `ml` | `hybrid`)

- **Regra de alarme** (microsleep, olhos fechados, PERCLOS crítico): sempre dispara `ALARM`.
- **ML ≥ 0,85** → `ML_WARNING` (em `ml`/`hybrid`).
- **ML ≥ 0,95** → `ML_ALARM` **somente com uma regra de aviso fisiológica ativa** (PERCLOS,
  fechamento prolongado, tendência de EAR, piscadas lentas, bocejo, queda de cabeça; `FACE_LOST`
  não conta). **O ML não origina ALARM sozinho.**
- `ml` e `hybrid` são hoje equivalentes (regras + ML); `rules` ignora o ML.
- ML indisponível, com erro ou score velho (> 1,5 s; ≤ 8 s se já em ALARM) → `null` → só regras.
- Liberação do ALARM exige ML < 0,70 (ou `null`), olhos abertos e PERCLOS baixo.

### Inferência

- Throttle de 200 ms; um `run()` em voo por vez; resultado de geração anterior (após `reset()`/timeout) é descartado.
- 3 falhas consecutivas → status `error` na UI; o engine segue em regras.
- Sem fallback de modelo por CDN de terceiros; o WASM do ORT é carregado do jsDelivr **na mesma versão** do pacote instalado.

### Modelo ONNX

- **Origem:** `ml/scripts/generate_realistic_model.py` (dados **sintéticos**; `drowsiness.model-card.json` ao lado do `.onnx`).
- **Treino com dados reais (ainda não feito):** `extract_features.py` → `train_model.py` → `evaluate.py` (ver ML_PIPELINE.md §10).
- **Não é** int8 nem foi treinado em NTHU/UTA (afirmações anteriores desta doc estavam incorretas).

### UI

- `MlStatusCard`: mostra status do modelo (carregando/pronto/erro) e score de sonolência em %.
- `StatusGauge` e `StatusDashboard`: labels para `ML_WARNING` e `ML_ALARM`.
- `App.tsx`: `MlStatusCard` entre CalibrationPanel e StatusDashboard.

### Dependências

- **Frontend:** `onnxruntime-web` (lazy-loaded via dynamic import).
- **Python (ml/):** `scikit-learn`, `onnx`, `skl2onnx`, `onnxruntime`, `pandas`, `numpy`, `opencv-python-headless`, `mediapipe`.
