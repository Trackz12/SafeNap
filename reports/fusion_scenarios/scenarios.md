# Bateria de cenários sintéticos — SafetyManager (sistema integrado, visão + FSR)

Cenarios sinteticos executados contra o SafetyManager real, combinando eventos de visao (self-declared pelo frontend) e sinais de garra (GripMonitor) para verificar especificamente a garantia central da fusao OR por severidade: nenhuma fonte consegue suprimir um alarme ativo originado pela outra. Verificacao de especificacao, nao validacao com condutores reais em condicao dinamica de direcao.

**11/11** cenários classificados conforme a verdade-fundamental atribuída.

## Matriz de confusão (binária: alerta = WARNING ou ALARM vs. sem alerta = NORMAL)

| | Previsto: alerta | Previsto: sem alerta |
|---|---|---|
| **Real: alerta** | VP=7 | FN=0 |
| **Real: sem alerta** | FP=0 | VN=4 |

Precisão: **1.000** · Recall: **1.000** · F1: **1.000**

## Cenários individuais

| Cenário | Descrição | Verdade | Previsto | OK |
|---|---|---|---|---|
| ambos_normais | Nenhuma fonte ativa | NORMAL | NORMAL | ✅ |
| apenas_visao_alarme | Só a visão dispara ALARM | ALARM | ALARM | ✅ |
| apenas_garra_alarme | Só a garra (FSR) dispara ALARM | ALARM | ALARM | ✅ |
| apenas_visao_aviso | Só a visão dispara WARNING | WARNING | WARNING | ✅ |
| apenas_garra_aviso | Só a garra dispara WARNING | WARNING | WARNING | ✅ |
| visao_alarme_domina | Visão ALARM + garra WARNING -> ALARM (mais severo vence) | ALARM | ALARM | ✅ |
| visao_sobrevive_garra_normaliza | Garra normaliza mas visão ALARM persiste | ALARM | ALARM | ✅ |
| garra_sobrevive_visao_termina | Visão termina mas garra ALARM persiste | ALARM | ALARM | ✅ |
| ack_zera_ambas | ALARM_ACKNOWLEDGED zera visão e garra juntas | NORMAL | NORMAL | ✅ |
| cai_so_com_ambas_liberadas | Estado só cai a NORMAL quando ambas as fontes liberam | NORMAL | NORMAL | ✅ |
| desconexao_total | Última desconexão zera as duas fontes (fail-safe) | NORMAL | NORMAL | ✅ |
