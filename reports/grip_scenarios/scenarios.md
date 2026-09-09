# Bateria de cenários sintéticos — GripMonitor (FSR isolado)

Cenarios sinteticos executados contra o GripMonitor real (nao uma reimplementacao), com relogio controlado. Verdade-fundamental atribuida pelos autores com base nos limiares documentados em docs/HARDWARE.md -- verificacao de especificacao, nao validacao com dados humanos reais (nao ha dataset publico de pressao de empunhadura veicular disponivel, diferente da visao computacional).

**10/10** cenários classificados conforme a verdade-fundamental atribuída.

## Matriz de confusão (binária: alerta = WARNING ou ALARM vs. sem alerta = NORMAL)

| | Previsto: alerta | Previsto: sem alerta |
|---|---|---|
| **Real: alerta** | VP=4 | FN=0 |
| **Real: sem alerta** | FP=0 | VN=6 |

Precisão: **1.000** · Recall: **1.000** · F1: **1.000**

## Cenários individuais

| Cenário | Descrição | Verdade | Previsto | OK |
|---|---|---|---|---|
| pressao_estavel | Pressão constante na baseline | NORMAL | NORMAL | ✅ |
| queda_breve_300ms | Queda de pressão por 300ms (< WARNING_MS=500ms) | NORMAL | NORMAL | ✅ |
| queda_sustentada_600ms | Queda de pressão por 600ms (> WARNING_MS=500ms) | WARNING | WARNING | ✅ |
| queda_sustentada_1200ms | Queda de pressão por 1200ms (> ALARM_MS=1000ms) | ALARM | ALARM | ✅ |
| recuperacao_apos_alarme | Pressão volta acima de 60% da baseline após ALARM | NORMAL | NORMAL | ✅ |
| recuperacao_parcial_nao_libera | Pressão sobe mas fica entre 35% e 60% da baseline (histerese não libera) | WARNING | WARNING | ✅ |
| deriva_gradual_baseline | Deriva lenta de pressão (baseline adaptativa acompanha) | NORMAL | NORMAL | ✅ |
| sem_calibracao | Leitura baixa isolada sem baseline calibrada ainda | NORMAL | NORMAL | ✅ |
| alarme_sustentado_sem_autocorte | Queda mantida por 30s — sem corte automático | ALARM | ALARM | ✅ |
| reset_apos_reconexao | Reset (simula queda/reconexão de serial) limpa o estado | NORMAL | NORMAL | ✅ |
