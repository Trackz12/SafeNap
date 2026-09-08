# Bateria de cenários sintéticos — Detection Engine

Cenários sintéticos executados contra o DetectionEngine real (não uma reimplementação), com relógio controlado (vi.setSystemTime) para atingir durações exatas. Verdade-fundamental atribuída pelos autores com base nos limiares documentados em docs/DETECTION.md — isto é verificação de especificação, não validação com dados humanos reais.

**15/15** cenários classificados conforme a verdade-fundamental atribuída.

## Matriz de confusão (binária: alerta = WARNING ou ALARM vs. sem alerta = NORMAL)

| | Previsto: alerta | Previsto: sem alerta |
|---|---|---|
| **Real: alerta** | VP=7 | FN=0 |
| **Real: sem alerta** | FP=0 | VN=8 |

Precisão: **1.000** · Revocação (recall): **1.000** · F1: **1.000**

## Cenários individuais

| Cenário | Descrição | Verdade | Previsto | Razão | OK |
|---|---|---|---|---|---|
| blink_curto_60ms | Piscada de ~60ms (limite inferior da faixa normal 50-400ms) | NORMAL | NORMAL | — | ✅ |
| blink_tipico_200ms | Piscada típica de ~200ms | NORMAL | NORMAL | — | ✅ |
| blink_limite_390ms | Piscada de ~390ms (limite superior da faixa normal, maxBlinkMs=400) | NORMAL | NORMAL | — | ✅ |
| fechamento_abaixo_aviso_600ms | Olhos fechados por 600ms (< warnCloseMs=700ms) | NORMAL | NORMAL | — | ✅ |
| fechamento_prolongado_900ms | Olhos fechados por 900ms (> warnCloseMs=700ms) | WARNING | WARNING | PROLONGED_CLOSE | ✅ |
| fechamento_critico_1700ms | Olhos fechados por 1700ms (> drowsinessThresholdMs=1500ms) | ALARM | ALARM | EYES_CLOSED_DURATION | ✅ |
| microsleep_agudo_2000ms | EAR muito baixo (nível micro-sono) sustentado por 2000ms | ALARM | ALARM | MICROSLEEP | ✅ |
| recuperacao_apos_alarme | Reabertura sustentada dos olhos após ALARM (EYES_CLOSED_DURATION) | NORMAL | NORMAL | — | ✅ |
| bocejo_confirmado_500ms | Boca aberta (aspect 0.75) sustentada por 500ms | WARNING | WARNING | YAWN | ✅ |
| bocejo_nao_confirmado_200ms | Boca aberta por apenas 200ms (< yawnMinMs=400ms) | NORMAL | NORMAL | — | ✅ |
| queda_cabeca_confirmada_2500ms | Nariz abaixo do baseline+margem sustentado por 2500ms | WARNING | WARNING | HEAD_DROP | ✅ |
| queda_cabeca_curta_1000ms | Queda de cabeça por apenas 1000ms (< headDropMinMs=2000ms) | NORMAL | NORMAL | — | ✅ |
| rosto_ausente_confirmado_6000ms | Rosto ausente por 6000ms | WARNING | WARNING | FACE_LOST | ✅ |
| rosto_ausente_curto_2000ms | Rosto ausente por apenas 2000ms (< faceLostWarnMs=5000ms) | NORMAL | NORMAL | — | ✅ |
| tendencia_declinio_gradual | EAR=0.25 sustentado (declínio de 28,6% vs. baseline 0.35), olhos nunca fecham | WARNING | WARNING | EAR_TREND | ✅ |
