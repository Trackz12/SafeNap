# Sonda: o ML experimental pode atrapalhar a deteccao?

Grade sintetica de estados plausiveis, NAO uma amostra de pessoas reais. Mede a resposta do modelo a vetores nas escalas que o frontend produz; nao mede a prevalencia desses estados na populacao.

Modelo: `frontend/public/models/drowsiness.onnx`  ·  estados acordados avaliados: **20736**

Definicao ESTRITA de acordado, para nao contaminar o resultado com estados que ja sao
sonolencia: `perclos <= 0.08`, `earTrendPerSec >= -0.01`, `earStdDev <= 0.035`.
O EAR **absoluto** varia livre de proposito — e a hipotese sob teste.

| Limiar | O que acontece ao cruzar | Estados acordados que cruzam |
|---|---|---|
| `>= 0.70` | passa a somar no score continuo de fusao | **6912** (33.3%) |
| `>= 0.85` | gera `ML_WARNING` **sozinho**, sem regra fisiologica | **3456** (16.7%) |
| `>= 0.95` | nivel de `ML_ALARM` (ainda exige corroboracao) | **0** (0.0%) |

Pior caso acordado: **P(drowsy) = 0.894** com `ear=0.13`, `mouth=0.15`, `nose=0.25`, `blink=6`, `perclos=0.0`, `std=0.035`, `trend=0.0`, `msb=1000`, `yaw=0.02`

## Isolando o EAR absoluto

Resto canonicamente acordado (`nose=0.30`, `blink=16`, `perclos=0.02`).
As REGRAS comparam o EAR ao limiar calibrado da pessoa; o ML ve o valor absoluto.

| EAR absoluto | P(drowsy) |
|---|---|
| 0.35 | 0.392 |
| 0.30 | 0.392 |
| 0.24 | 0.535 |
| 0.20 | 0.666 |
| 0.18 | 0.666 |
| 0.16 | 0.666 |
| 0.14 | 0.666 |
| 0.12 | 0.666 |
