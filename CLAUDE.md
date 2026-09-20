# SafeNap — Contexto para IAs

Leia `.ai/memory.md` no início de toda sessão: é a memória de longo prazo deste projeto (histórico de sessões, decisões, lições, acumulado por qualquer IA que trabalhou aqui).

Regras de negócio e arquitetura obrigatórias: ver [AGENTS.md](AGENTS.md).

Rotina de memória (comum a qualquer IA atuando aqui):
1. **Início de sessão** — ler `.ai/memory.md` (e `.ai/state.md` para estado técnico).
2. **Fim de trabalho significativo** — anexar entrada no formato definido em AGENTS.md § Memória de Longo Prazo.
3. Log é append-only: nunca reescrever histórico.

Este projeto também é indexado no segundo cérebro do usuário (vault Obsidian `segundo-cerebro`, página [[projeto-safenap]]).
