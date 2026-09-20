# Pipeline de dataset (UTA-RLDD / NTHU-DDD) — auditoria e procedimento

> **Estado: pipeline preparado e testado com dados FABRICADOS. Nenhum arquivo real do UTA-RLDD ou do
> NTHU-DDD foi processado.** Portanto: os adaptadores **não** foram validados contra os datasets oficiais,
> nenhuma métrica de sonolência existe, e nada aqui autoriza dizer que o SafeNap detecta sonolência em
> condutores. O ONNX embarcado continua **EXPERIMENTAL** (sintético; ver `docs/ML_PIPELINE.md`).

> **Testes sintéticos validam o comportamento do adaptador; não validam a correspondência do adaptador
> com o dataset oficial.** Essa só se verifica com os arquivos reais, pelo `--dry-run` (§7) e pela leitura
> da documentação oficial (§9, passo 1).

## 1. Etapas separadas — nada encadeia sozinho

```
[1] build_manifest.py   dataset -> manifest -> validação -> dataset_summary.json      (rápido; --dry-run não escreve)
[2] (revisão humana)    ler o resumo, a tabela de rótulos, as exclusões e os avisos
[3] extract_features.py manifest -> validação de novo -> features.csv + *_extraction_report.json (pesado)
[4] train_model.py      features.csv -> validação de novo -> split por sujeito -> modelo -> ONNX -> relatório
```

Nenhum script baixa dados nem chama o seguinte. `download_datasets.py` só cria pastas e lembra o que fazer.
Cada etapa recusa entrada inválida (exit code ≠ 0) e a etapa seguinte **revalida** o que recebe; não se
confia que a anterior foi rodada.

## 2. Auditoria dos adaptadores (`ml/dataset_adapters/`)

| Pergunta | UTA-RLDD (`uta_rldd.py`) | NTHU-DDD (`nthu_ddd.py`) |
|---|---|---|
| Estrutura assumida | `<raw>/**/<sujeito>/<0\|5\|10>.<ext>` — **NÃO confirmada** | tabela de pares `video,annotation,subject_id`; anotação = string de `0`/`1` por frame — **formato NÃO confirmado** |
| **Sujeito** | nome da pasta-pai, com namespace `uta_rldd:<pasta>` | coluna `subject_id`, com namespace `nthu_ddd:<id>` (vários cenários do mesmo motorista → mesmo id) |
| **Vídeo** | caminho relativo a `--raw` (`video_id = <dataset>:<caminho sem extensão>`) | idem |
| **Clipe** | `(vídeo, rótulo)`; um vídeo = um clipe | `(vídeo, rótulo)`; um vídeo segmentado vira um clipe por rótulo |
| **Rótulo** | stem do arquivo → `UTA_LABEL_MAP` | caractere da anotação → `NTHU_LABEL_MAP` |
| **Frames** | o adaptador não os encontra; `extract_features.py` lê o vídeo (OpenCV) a `--fps` | idem; o índice do frame da anotação vira segundo via `--fps` (**obrigatório, sem padrão**) |
| **Segmentos** | não há; o vídeo inteiro herda a classe (rótulo por vídeo) | run-length da anotação → `[start_s, end_s)`; `t_ms` decide o rótulo |
| **Arquivo ausente** | só existem os arquivos encontrados; ausência no manifesto editado → erro em `validate_rows` | vídeo/anotação ausente → **problema**; idem na validação |
| **Rótulo desconhecido** | nome fora de `{0,5,10}` → problema ("não vou adivinhar") | caractere ≠ `0`/`1` → problema |
| **Duplicatas** | `(sujeito, classe)` repetido; mesmo nome de sujeito em pastas diferentes → problema | mesmo vídeo em dois pares; mesma anotação em dois vídeos → problema |
| **Vídeo vazio** | 0 bytes → erro (`validate_rows`); sem frames/ilegível → erro com `--probe`, ou na extração | idem; anotação vazia → problema |
| **Exclusões** | classe `5` registrada (`Excluded`: vídeo, sujeito, dataset, rótulo, motivo, `kind`) | segmentos de mapa não confirmado registrados como `unverified` |
| Falhas globais (lançam `DatasetLayoutError`) | `--raw` inexistente; nenhum vídeo | tabela sem colunas / vazia; `--fps` ausente |

Problemas por item são **coletados**, não lançados no primeiro: o dry-run lista todos de uma vez.

## 3. Mapeamento de rótulos (`LabelMap`) — todos `UNVERIFIED`

Cada mapa tem um **id** (`uta_rldd/v1`, `nthu_ddd/v1`). Os mapeamentos de inclusão nascem `UNVERIFIED` porque
vêm da descrição publicada dos datasets, **não conferida aqui**. Só entram no manifesto com
`--confirm-labels <id>`, depois de você ler a documentação oficial. Se o mapa mudar, o id muda e a
confirmação antiga deixa de valer.

| Dataset | Rótulo original | SafeNap | Incluído? | Status | Motivo |
|---|---|---|---|---|---|
| UTA-RLDD | `0` | 0 alerta | só após `--confirm-labels` | UNVERIFIED | alerta (descrição publicada) |
| UTA-RLDD | `10` | 1 sonolento | só após `--confirm-labels` | UNVERIFIED | sonolento (descrição publicada) |
| UTA-RLDD | `5` | — | **não** | EXCLUDED | baixa vigilância: sem equivalente binário defensável |
| NTHU-DDD | `0` | 0 alerta | só após `--confirm-labels` | UNVERIFIED | não sonolento (formato assumido) |
| NTHU-DDD | `1` | 1 sonolento | só após `--confirm-labels` | UNVERIFIED | sonolento (formato assumido) |
| NTHU-DDD | anotações de olhos/boca/cabeça | — | **não usadas** | — | são outras tarefas, não rótulo de sonolência |

`--dry-run` **simula** a confirmação só para checar o layout, avisa isso e imprime a tabela com
"confirmado pelo usuário: NAO". Um manifesto real nunca sai sem confirmação. Ressalva científica: no UTA o
rótulo vale para o vídeo inteiro (~10 min), não por instante — trechos despertos num vídeo "10" são ruído de
rótulo.

## 4. Identidade de sujeito e de vídeo

- **Namespace**: `uta_rldd:11`, `nthu_ddd:001`. O mesmo id em dois datasets nunca se funde; a validação falha
  se um mesmo `subject_id` aparece em mais de um dataset.
- **`subject_key`** (chave de identidade): minúsculas, só alfanumérico, sem zeros à esquerda de números.
  `subject01`/`subject1`/`Subject-1` e `01`/`1` colidem → **falha por segurança** (podem ser a mesma pessoa);
  `001`, `002`, `010`, `100` continuam distintos. Limite honesto: `s1` vs `subject1` **não** são detectados —
  o `subject_id` do manifesto precisa identificar a *pessoa*.
- **`video_id`** = `<dataset>:<caminho relativo sem extensão>`. Nunca `video.stem` (regressão coberta por
  teste: `subject01/0.mp4` e `subject02/0.mp4` são vídeos distintos).
- **Mistura de sujeitos**: mesmo vídeo com dois sujeitos, ou `video_id` com dois sujeitos no CSV → erro.
- **Arquivos idênticos** sob caminhos diferentes (tamanho + SHA-256 dos primeiros/últimos 1 MiB) → erro
  (possível mesma pessoa/vídeo sob duas identidades).

## 5. Estado temporal (PERCLOS, piscadas, janela)

- **Vídeo físico novo ⇒ estado novo.** `process_video` cria `FeatureExtractor` e `BlinkTracker` por chamada;
  nada passa de um vídeo para o próximo (teste dedicado).
- **Mesmo vídeo, rótulo diferente ⇒ estado contínuo.** Várias linhas do manifesto para o mesmo vídeo viram
  **uma** passada com rótulo por instante (`label_at`, intervalos semiabertos). Os frames fora de qualquer
  segmento atualizam o estado, mas não geram linha. Teste: as features após a troca de rótulo são idênticas
  às de uma passada sem segmentação, e o PERCLOS carrega o piscar anterior; reiniciar o estado o perderia.
- Timestamps inválidos ou não crescentes são descartados e **contados** (`bad_timestamp`), pois corromperiam
  PERCLOS/piscadas.
- Diferença conhecida com produção: o limiar de EAR offline é fixo (`--ear-threshold`, 0,21), não a
  calibração individual.

## 6. Rastreabilidade e integridade

**Manifesto**: `dataset, dataset_version, video, subject_id, label, source_label, start_s, end_s`.

**CSV de features**: `dataset, subject_id, video_id, clip_id, relative_path, frame_index, t_ms, <18 features>,
label, source_label`. Toda linha aponta para o dado original: `relative_path` + `frame_index` (índice no vídeo
original, antes de subamostrar) + `t_ms`. Em vídeos segmentados `source_label` fica vazio (o rótulo por
instante vem do manifesto). `dataset_version` fica no manifesto e no resumo (padrão `UNVERIFIED`; informe
`--dataset-version`).

**Nada é convertido em 0.** Cada frame que não vira linha é contado por motivo:
`no_face`, `invalid_face`, `bad_timestamp`, `window_warmup`, `non_finite_features`, `outside_segment`. O
`<out>_extraction_report.json` lista, por vídeo e no total, `reason / count / dataset / subject / video`, e
vale `rows + descartes = frames_read`. Vídeo corrompido, sem frames ou sem nenhuma linha utilizável **aborta**
a extração (exit 2); `--skip-unreadable` o registra como exclusão em vez de esconder. O CSV nasce como
`<out>.partial` e só ganha o nome final se passar `validate_features` — um dataset incompleto ou inválido
nunca se disfarça de completo.

## 7. `dataset_summary.json` (antes de qualquer extração/treino) e dry-run

Campos: `datasets, subjects, videos, clips, frames (só com --probe), included_samples, excluded_samples,
labels, class_distribution, subjects_per_class, videos_per_class, exclusion_reasons` + a tabela de rótulos
usada. `included/excluded_samples` contam **linhas de manifesto** (vídeo/segmento), não frames.

```bash
python scripts/build_manifest.py uta  --raw ../data/raw/uta --dry-run [--probe]     # não escreve nada
python scripts/build_manifest.py nthu --raw ../data/raw/nthu --pairs pares.csv --fps <fps real> --dry-run
python scripts/validate_manifest.py --manifest m.csv --raw ../data/raw/uta [--probe] # manifesto revisado/à mão
python scripts/extract_features.py --raw ... --manifest m.csv --dry-run              # valida sem extrair
```

O dry-run mostra dataset detectado, sujeitos, vídeos, rótulos, amostras e **todos** os problemas, sem
processamento pesado. `--probe` abre cada vídeo (OpenCV) só para ler frames/fps e confere a duração do vídeo
contra o fim da anotação (anotação mais longa que o vídeo ⇒ erro, típico de `--fps` errado).

## 8. Proteção contra leakage

| Risco | Onde é barrado | Resultado |
|---|---|---|
| Mesmo sujeito em treino/validação/teste | `assert_disjoint` no holdout e em **cada fold** do GroupKFold | `ValueError` |
| Mesmo vídeo em dois conjuntos | `assert_disjoint` (vídeo) no holdout e nos folds | `ValueError` |
| Mesmo clipe em dois conjuntos | `assert_disjoint` (clipe) no holdout | `ValueError` |
| Segmentos do mesmo vídeo em conjuntos diferentes | vídeo pertence a um só sujeito (validação) + barreira de vídeo acima | erro |
| Frames duplicados | `(video_id, t_ms)` repetido; timestamps fora de ordem → `validate_features` | erro |
| Arquivos duplicados | assinatura de arquivo (manifesto) e vetores de 18 features idênticos em sujeitos diferentes (CSV) | erro |
| Dúvida sobre identidade | `subject_key` colide | erro (**fail-safe**) |

A validação (= out-of-fold do GroupKFold) usa só sujeitos de treino, logo também é disjunta do teste.
`experiment.json` registra `subject_leakage / video_leakage / clip_leakage = 0` (o treino já teria abortado se
fosse > 0). Limite: a barreira de vídeo/clipe no `train()` é defesa em profundidade; a validação do CSV já
barra esses casos antes.

## 9. Procedimento quando o dataset real chegar (nenhum passo pode ser pulado)

1. **Conferir a documentação oficial** do dataset: estrutura de pastas, significado dos rótulos, fps, versão.
2. `build_manifest.py ... --dry-run [--probe]`.
3. Revisar o `dataset_summary` impresso (sujeitos, vídeos, classes, exclusões, avisos).
4. **Validar os rótulos**: comparar a tabela impressa com a documentação oficial; se algo diferir, corrigir o
   adaptador (e o **id** do mapa) — não usar `--confirm-labels` com dúvida.
5. **Validar sujeitos**: ids inequívocos e uma linha por *pessoa* (o pipeline não sabe quem é a mesma pessoa).
6. **Validar vídeos**: nenhum ausente/ilegível/duplicado; `--probe` sem erros.
7. **Validar exclusões**: cada classe excluída tem motivo defensável e contagem esperada.
8. `build_manifest.py ... --out ... --confirm-labels <id> --dataset-version "<versão>"`.
9. **Revisar o manifesto** e o `dataset_summary.json` gerados.
10. `extract_features.py ...` (usa `--dry-run` antes, se quiser).
11. **Validar a quantidade de features**: `*_extraction_report.json` (`status: OK`, `rows + descartes =
    frames_read`, exclusões por motivo) e o resumo do CSV (sujeitos/vídeos/clipes/linhas por classe).
12. Split por sujeito (feito dentro do `train_model.py`; leakage = 0 no relatório).
13. `train_model.py --out-dir ../reports/ml/<run> --dataset-name "<nome/versão>" --seed 42`.
14. Avaliação: `metrics.json` (unidade **window** e **clip**) e `experiment.json`.
15. Exportação ONNX (`drowsiness.onnx`, feita no treino).
16. **Paridade Python × ONNX** (feita no treino: `max_abs_prob_diff`; e `evaluate.py --model-card`).
17. Rodar os testes: `pytest ml/tests` e `npx vitest run` (paridade com o frontend). Só então considerar
    `--deploy` — manual, e o card sai `EXPERIMENTAL`.

## 10. O que continua NÃO validado

- A correspondência real dos adaptadores com UTA-RLDD e NTHU-DDD (layout, rótulos, fps).
- Qualquer desempenho de detecção de sonolência (não há dataset processado nem treino real).
- A conversão rótulo-por-vídeo (UTA) em rótulo-por-instante: é uma limitação do dataset.
- Agregação por pessoa, intervalos de confiança por sujeito, validação em condutores reais.
