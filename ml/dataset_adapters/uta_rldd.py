"""Adaptador do UTA-RLDD (Real-Life Drowsiness Dataset) -> manifesto de extração.

ESTRUTURA ASSUMIDA (NÃO CONFIRMADA contra o download real — este ambiente não tem o dataset):
    <raw>/**/<subject>/<classe>.<ext>      com classe em {0, 5, 10}
    Um vídeo por (sujeito, classe): o NOME DO ARQUIVO é o rótulo e a PASTA-PAI é o sujeito.

Como cada coisa é identificada:
    sujeito : nome da pasta-pai, com namespace  ->  "uta_rldd:<pasta>"  (nunca colide com outro dataset)
    vídeo   : caminho relativo a --raw (o nome do arquivo sozinho, "0"/"5"/"10", repete em todo sujeito)
    clipe   : (vídeo, rótulo); aqui, um vídeo inteiro = um clipe
    rótulo  : stem do arquivo; passa pelo UTA_LABEL_MAP (nada é convertido fora dele)
    frames  : o adaptador NÃO os encontra; extract_features.py lê o vídeo com OpenCV a --fps
    segmentos: não há; o vídeo inteiro herda a classe (rótulo por vídeo, não por instante)
Problemas COLETADOS (não levantados no primeiro): nome de arquivo fora de {0,5,10}, vídeo sem pasta de
sujeito, (sujeito, classe) duplicado, o mesmo nome de sujeito em pastas diferentes (identidade duvidosa =
falha), rótulo desconhecido. Só `DatasetLayoutError` para falhas globais (raw inexistente, nenhum vídeo).
Vídeo vazio / ilegível / ausente é detectado em `validation.py` (existência, tamanho, `--probe`).

MAPEAMENTO DE RÓTULOS (todos UNVERIFIED até confirmação explícita; ver `UTA_LABEL_MAP.table()`):
    "0"  -> 0 alerta       "10" -> 1 sonolento       "5" -> EXCLUÍDO (baixa vigilância)
  As duas inclusões vêm da descrição publicada do dataset, que NÃO foi conferida aqui.
  "5" é excluído por desenho: como "alerta" ensinaria que sonolência leve é normal; como "sonolento"
  inflaria a classe positiva.
Ressalva: no UTA o rótulo vale para ~10 min inteiros, não por instante; trechos despertos dentro de um
vídeo "10" viram ruído de rótulo.
"""

from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional, Set

from .common import (BuildResult, DEFAULT_VERSION, DatasetLayoutError, EXCLUDED_BY_DESIGN, Excluded,
                     LABEL_ALERT, LABEL_DROWSY, LabelMap, LabelRule, ManifestRow, UNVERIFIED,
                     relative_posix)

DATASET = "uta_rldd"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".m4v", ".mkv"}

UTA_LABEL_MAP = LabelMap(id="uta_rldd/v1", dataset=DATASET, rules=(
    LabelRule("0", LABEL_ALERT, UNVERIFIED, "alerta (descrição publicada; conferir na documentação oficial)"),
    LabelRule("10", LABEL_DROWSY, UNVERIFIED, "sonolento (descrição publicada; conferir na documentação oficial)"),
    LabelRule("5", None, EXCLUDED_BY_DESIGN,
              "baixa vigilância: categoria intermediária sem equivalente binário defensável"),
))


def build_uta_manifest(raw: Path, confirm_labels: Optional[str] = None,
                       dataset_version: str = DEFAULT_VERSION) -> BuildResult:
    raw = raw.resolve()
    if not raw.is_dir():
        raise DatasetLayoutError(f"--raw não é um diretório: {raw}")
    videos = sorted(p for p in raw.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS)
    if not videos:
        raise DatasetLayoutError(f"nenhum vídeo ({sorted(VIDEO_EXTENSIONS)}) sob {raw}")

    result = BuildResult()
    seen: Dict[tuple, str] = {}
    parents_by_subject: Dict[str, Set[str]] = defaultdict(set)
    classes_by_subject: Dict[str, Set[str]] = defaultdict(set)
    for v in videos:
        rel = relative_posix(v, raw)
        source = v.stem
        if v.parent == raw:
            result.problems.append(f"{rel}: sem pasta de sujeito acima do vídeo")
            continue
        subject = f"{DATASET}:{v.parent.name}"
        res = UTA_LABEL_MAP.resolve(source, confirm_labels)
        if res.kind == "unknown":
            result.problems.append(f"{rel}: nome '{source}' não é uma classe UTA conhecida "
                                   f"{list(UTA_LABEL_MAP.sources())}; a estrutura real difere da assumida "
                                   f"(não vou adivinhar)")
            continue
        if (subject, source) in seen:
            result.problems.append(f"{rel}: sujeito '{v.parent.name}' já tem a classe {source} em {seen[(subject, source)]}")
            continue
        seen[(subject, source)] = rel
        parents_by_subject[subject].add(relative_posix(v.parent, raw))
        classes_by_subject[subject].add(source)
        if res.kind == "include":
            result.rows.append(ManifestRow(video=rel, subject_id=subject, label=res.label, source_label=source,
                                           dataset=DATASET, dataset_version=dataset_version))
        else:
            result.excluded.append(Excluded(video=rel, source_label=source, reason=res.reason,
                                            subject_id=subject, dataset=DATASET, kind=res.kind))

    for subject, parents in sorted(parents_by_subject.items()):
        if len(parents) > 1:
            result.problems.append(f"{subject}: o mesmo nome de sujeito aparece em pastas diferentes "
                                   f"{sorted(parents)} (identidade duvidosa: falha por segurança)")
    for subject, classes in sorted(classes_by_subject.items()):
        lacking = sorted(set(UTA_LABEL_MAP.sources()) - classes)
        if lacking:
            result.warnings.append(f"{subject}: sem vídeo das classes {lacking}")
    return result
