# SafeNap — Estado Técnico Atual

> Atualizar quando a realidade mudar (stack, comandos, convenções). Data da última atualização: 2026-09-19 (auditoria de ML).

## Stack (a confirmar/preencher na primeira sessão de trabalho)

- **Frontend**: React (processamento de câmera/MediaPipe 100% local no navegador)
- **Backend**: responsável pelo hardware — `SerialManager` é o único que fala com o Arduino (PySerial)
- **Hardware**: Arduino (ver `hardware/`, `arduino/`)
- **ML**: pasta `ml/` — ONNX embarcado é SINTÉTICO/EXPERIMENTAL (ver `docs/ML_PIPELINE.md`); schema único em `shared/feature_schema.json`
- **Docs de protocolo**: `docs/WEBSOCKET_PROTOCOL.md`, `docs/HARDWARE.md` — atualizar a cada mudança de protocolo

## Comandos

- Frontend: `cd frontend && npx vitest run && npx tsc -b` (219 testes em 21 arquivos)
- ML Python: `cd ml && .venv/Scripts/python.exe -m pytest tests` (96 testes); ambiente: Python 3.14 + `ml/requirements.lock.txt`
- Dataset real (não disponível ainda; ver `docs/DATASET_PIPELINE.md`): `build_manifest.py --dry-run` -> `--confirm-labels` -> `validate_manifest.py` -> `build_manifest.py` -> `extract_features.py` -> `train_model.py --out-dir ../reports/ml/<run>` (ver `docs/ML_PIPELINE.md` §13)
- Regerar fixtures de paridade (só se schema/geometria/modelo mudarem): `cd ml && python scripts/make_golden_fixture.py`
- Backend/hardware: (a documentar)

## Convenções

- Regras obrigatórias de arquitetura: `AGENTS.md` (10 regras)
- Comunicação serial só no backend; frames de vídeo nunca vão ao backend
- Modelo do usuário (RF em sessão) desligado por padrão: `VITE_ENABLE_USER_MODEL=true` só para experimentação
- ML não origina ALARM sozinho (`frontend/src/ml/mlReasons.ts`); mudar a ordem das features invalida todo ONNX
- Projeto antigo = referência funcional de algoritmos apenas, nunca copiar arquitetura
