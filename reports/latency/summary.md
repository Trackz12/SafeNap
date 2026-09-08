# Orçamento de latência do SafeNap — decomposto por etapa

Todos os números abaixo são **medidos** (com metodologia e script reproduzíveis)
ou **calculados** (fórmula determinística), nunca estimados de memória. Cada
etapa está rotulada com sua origem. Reproduza rodando os scripts referenciados.

| # | Etapa | Origem | Valor (mediana) | Como reproduzir |
|---|---|---|---|---|
| 1 | Extração de 478 landmarks (MediaPipe FaceLandmarker) | **Fora do escopo** — roda em WASM no navegador do usuário, tempo depende do hardware/browser dele | não medido | — |
| 2 | `analyzeFrame` (geometria EAR/boca/nariz) | Medido (JS, Node, `vitest bench`) | **~0,0001 ms** (≈100 ns) | `npx vitest bench src/detection/latency.bench.ts` |
| 3 | `FeatureExtractor.extract` (18 features) | Medido (JS, Node, `vitest bench`) | **~0,0009 ms** | idem |
| 4 | `DetectionEngine.processFrame` (regras + fusão, regime estável) | Medido (JS, Node, `vitest bench`) | **~0,0021 ms** | idem |
| 5 | WebSocket navegador → backend (ida e volta) | Medido (backend real, `uvicorn`, loopback) | **~0,085 ms** | `python backend/scripts/measure_ws_roundtrip.py` |
| 6 | `SafetyManager.process_event` (decisão + despacho do comando) | Medido (Python, serial mockado) | **~0,097 ms** | `python backend/scripts/measure_latency.py` |
| 7 | Transmissão serial USB → Arduino (`ALARM_ON`, 9600 bps) | **Calculado** (fórmula 8N1, não medido — sem hardware físico neste ambiente) | **~9,4 ms** | `reports/latency/serial_transmission_calc.md` |

## Soma das etapas medidas/calculadas (2–7)

**≈ 9,5 ms** — dominada quase inteiramente pela transmissão serial (etapa 7,
calculada), que sozinha responde por ~99% do total. As etapas de software
(2–6) somadas ficam na casa de **0,1 ms**.

## O que isso NÃO prova

- **Não inclui a etapa 1** (extração de landmarks), que na prática é a maior
  fatia real da latência ponta-a-ponta — só não temos como medi-la sem um
  navegador real rodando em hardware real de usuário. Literatura de MediaPipe
  reporta tipicamente dezenas de ms por frame em CPU, mas isso varia demais
  por dispositivo para citarmos como se fosse nosso dado.
- **Não inclui rede real** (Tailscale/Wi-Fi de um veículo em movimento) — a
  etapa 5 foi medida em loopback local (`127.0.0.1`), que é um piso, não o
  pior caso.
- **Não inclui o comportamento físico real da UART** (buffers do driver
  USB-serial CH340/FTDI, tempo de reação do `loop()` do Arduino) — a etapa 7
  é um cálculo teórico a partir do baud rate, não uma medição em bancada.

A afirmação defensável, com esses dados, é: **"o processamento de software
(navegador + backend) contribui menos de 1 ms para a latência total; o maior
componente calculável é a transmissão serial (~9,4 ms); a extração de
landmarks pelo MediaPipe permanece não medida e é provavelmente o maior
componente real da latência total — ponto que fica como validação de campo
necessária (trabalho futuro), não uma lacuna esperada apenas a esta revisão."**
