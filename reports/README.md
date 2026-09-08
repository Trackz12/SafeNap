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

## Validação com dados humanos reais (EAR) — pesquisado, não concluído

Para fechar a lacuna acima (validar o EAR contra rótulos de olho aberto/
fechado de pessoas reais, não só cenários sintéticos), pesquisamos datasets
públicos de acesso livre, sem necessidade de aprovação acadêmica:

- **MRL Eye Dataset** (84.898 imagens, rótulo aberto/fechado, download direto
  sem cadastro: `http://mrl.cs.vsb.cz/data/eyedataset/mrlEyes_2018_01.zip`) —
  **incompatível com nosso pipeline**: são recortes só do olho (infravermelho),
  e nosso EAR é calculado a partir de landmarks de rosto inteiro (MediaPipe
  FaceMesh) — não há rosto para detectar num recorte de olho.
- **CEW — Closed Eyes in the Wild** (2423 sujeitos, 1192 fechados / 1231
  abertos, imagens de **rosto inteiro com fundo** — compatível com nosso
  pipeline). Download direto testado e confirmado nesta sessão (sem
  cadastro, sem formulário): `https://drive.google.com/file/d/12DB4kwdeikxyQcK4gA7hL0QbzF6iOAZ2/view` —
  arquivo `.rar` de 20MB.

**Onde travou**: o arquivo é `.rar`, e este ambiente não tem `unrar`/`7-Zip`
instalado para extrair. Não baixei um executável de terceiros pra resolver
isso sozinho (mesmo sendo a ferramenta oficial e gratuita) — é uma decisão
melhor tomada por quem vai rodar isso na própria máquina.

**Próximo passo, se quiserem essa validação**: baixem o link acima (qualquer
WinRAR/7-Zip já resolve) e coloquem a pasta extraída em `ml/data/raw/cew/`.
A partir daí, o pipeline já existente (`ml/scripts/extract_features.py` —
requer `pip install opencv-python-headless mediapipe` no `ml/.venv`, que
ainda não estão instalados) processa as imagens com MediaPipe e calcula o
EAR real de cada uma; eu escrevo o script de comparação contra os rótulos
(`closed_eye_*`/`open_eye_*` no nome do arquivo) e gero a matriz de confusão
real, com dados humanos de verdade.
