# Regras para IA e Agentes

Estas regras são **OBRIGATÓRIAS** para qualquer agente ou IA trabalhando neste projeto:

1. **Frontend não acessa PySerial**: A comunicação serial é estritamente do backend.
2. **Backend é responsável pelo hardware**: Somente o `SerialManager` do backend interage com o Arduino.
3. **Câmera é processada localmente**: A captura e o processamento do MediaPipe (landmarks) devem acontecer 100% no navegador (frontend). Nunca enviar frames de vídeo para o backend.
4. **Responsabilidade Única**: Cada módulo deve possuir uma única responsabilidade.
5. **DRY**: Não duplicar lógica.
6. **Lógica de Interface Limpa**: Não colocar lógica crítica (como EAR ou Segurança) dentro dos componentes React.
7. **Documentação de Protocolo**: Qualquer alteração no protocolo WebSocket ou Serial exige atualização imediata da documentação em `docs/WEBSOCKET_PROTOCOL.md` ou `docs/HARDWARE.md`.
8. **Testes**: Testar localmente antes de considerar uma tarefa como concluída.
9. **Dependências**: Não adicionar bibliotecas sem real necessidade.
10. **Referência Antiga**: Consultar o projeto antigo apenas como **referência funcional** (para entender algoritmos). Não copiar a arquitetura do projeto antigo!

## Memória de Longo Prazo do Projeto

Este projeto mantém memória persistente entre sessões de IA em `.ai/memory.md`.

- **Ao iniciar qualquer sessão**: leia `.ai/memory.md` antes de trabalhar. É o histórico do que já foi feito, decisões tomadas e lições aprendidas — por qualquer IA (Claude, OpenCode, Gemini, etc.) ou humano.
- **Ao encerrar trabalho significativo**: anexe ao final de `.ai/memory.md` uma entrada no formato:
  ```
  ## [YYYY-MM-DD] <IA/humano> | <resumo de uma linha>
  - Feito: <mudanças principais>
  - Decisões: <decisões e por quê>
  - Lições: <armadilhas, padrões, o que funcionou>
  - Próximos passos: <pendências conhecidas>
  ```
- Nunca apague ou edite entradas antigas — o log é append-only.
- Estado técnico atual (stack, comandos, convenções) fica em `.ai/state.md`, atualizado quando a realidade muda.
