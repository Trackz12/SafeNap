"""Adaptador do NTHU-DDD -> manifesto de extração (rótulos POR FRAME -> segmentos).

O NTHU-DDD rotula quadro a quadro (o motorista alterna entre alerta e sonolento no mesmo vídeo).
Diferente do UTA, um vídeo tem VÁRIOS segmentos com rótulos distintos.

NADA sobre nomes de arquivos/pastas é assumido: o adaptador recebe uma tabela explícita de pares

    video,annotation,subject_id            (caminhos relativos a --raw)

Como cada coisa é identificada:
    sujeito : coluna subject_id da tabela, com namespace -> "nthu_ddd:<id>" (vários cenários do mesmo
              motorista DEVEM usar o mesmo id, para o split por sujeito mantê-los juntos)
    vídeo   : caminho relativo a --raw
    clipe   : (vídeo, rótulo); um vídeo com segmentos vira um clipe por rótulo
    rótulo  : caractere do arquivo de anotação por frame; passa pelo NTHU_LABEL_MAP
    frames  : o adaptador NÃO os encontra; o índice do frame de anotação vira segundos via --fps
              (obrigatório, sem padrão) e extract_features.py lê o vídeo com OpenCV
    segmentos: run-length dos rótulos por frame, intervalos [start_s, end_s)
O que É assumido (NÃO CONFIRMADO; o ambiente não tem o dataset): o arquivo de anotação de sonolência é uma
sequência de '0'/'1', um por frame (espaços/quebras ignorados). Qualquer outro caractere = problema.
Problemas COLETADOS: par incompleto, vídeo/anotação ausente ou fora de --raw, anotação ilegível/vazia,
caractere desconhecido, o mesmo vídeo em dois pares, a mesma anotação usada por dois vídeos.
Duração da anotação x duração do vídeo é conferida em `validation.py --probe`.

MAPEAMENTO DE RÓTULOS (UNVERIFIED até confirmação; `NTHU_LABEL_MAP.table()`):
    "0" (não sonolento) -> 0 alerta        "1" (sonolento) -> 1 sonolento
  As anotações de olhos/boca/cabeça do NTHU são OUTRAS tarefas e não são usadas como rótulo de sonolência.
"""

import csv
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .common import (BuildResult, DEFAULT_VERSION, DatasetLayoutError, Excluded, LABEL_ALERT, LABEL_DROWSY,
                     LabelMap, LabelRule, ManifestRow, UNVERIFIED, relative_posix)

DATASET = "nthu_ddd"
REQUIRED_PAIR_COLUMNS = ("video", "annotation", "subject_id")

NTHU_LABEL_MAP = LabelMap(id="nthu_ddd/v1", dataset=DATASET, rules=(
    LabelRule("0", LABEL_ALERT, UNVERIFIED, "não sonolento (formato assumido; conferir na documentação oficial)"),
    LabelRule("1", LABEL_DROWSY, UNVERIFIED, "sonolento (formato assumido; conferir na documentação oficial)"),
))
Segment = Tuple[float, float, str]  # (start_s, end_s exclusivo, caractere original)


def segments_from_frame_labels(labels: str, fps: float) -> List[Segment]:
    """Run-length dos rótulos por frame -> segmentos [start_s, end_s) com o rótulo original."""
    if not fps or fps <= 0:
        raise ValueError("fps deve ser > 0")
    seq = "".join(labels.split())
    if not seq:
        raise DatasetLayoutError("arquivo de anotação vazio")
    unknown = sorted(set(seq) - set(NTHU_LABEL_MAP.sources()))
    if unknown:
        raise DatasetLayoutError(
            f"caracteres {unknown} não são '0'/'1' — formato de anotação diferente do assumido")
    segments: List[Segment] = []
    start = 0
    for i in range(1, len(seq) + 1):
        if i == len(seq) or seq[i] != seq[start]:
            segments.append((start / fps, i / fps, seq[start]))
            start = i
    return segments


def build_nthu_manifest(pairs_csv: Path, raw: Path, fps: float, confirm_labels: Optional[str] = None,
                        dataset_version: str = DEFAULT_VERSION) -> BuildResult:
    if not fps or fps <= 0:
        raise ValueError("fps deve ser > 0 (sem padrão: informe o fps real dos vídeos)")
    raw = raw.resolve()
    result = BuildResult()
    videos_seen: Dict[str, int] = {}
    annotation_users: Dict[str, List[str]] = defaultdict(list)
    with open(pairs_csv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = [c for c in REQUIRED_PAIR_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise DatasetLayoutError(f"tabela de pares sem colunas {missing}")
        pairs = list(enumerate(reader, start=2))
    if not pairs:
        raise DatasetLayoutError("tabela de pares vazia")

    for n, row in pairs:
        video, ann, subject = (str(row.get(k) or "").strip() for k in REQUIRED_PAIR_COLUMNS)
        if not (video and ann and subject):
            result.problems.append(f"pares linha {n}: video/annotation/subject_id obrigatórios")
            continue
        try:
            video_rel = relative_posix(raw / video, raw)
            ann_rel = relative_posix(raw / ann, raw)
        except DatasetLayoutError as exc:
            result.problems.append(f"pares linha {n}: {exc}")
            continue
        if video_rel in videos_seen:
            result.problems.append(f"pares linha {n}: vídeo {video_rel} já listado na linha {videos_seen[video_rel]}")
            continue
        videos_seen[video_rel] = n
        annotation_users[ann_rel].append(video_rel)
        if not (raw / video_rel).is_file():
            result.problems.append(f"pares linha {n}: vídeo ausente: {video_rel}")
            continue
        try:
            segments = segments_from_frame_labels((raw / ann_rel).read_text(encoding="utf-8"), fps)
        except (OSError, UnicodeDecodeError) as exc:
            result.problems.append(f"pares linha {n}: anotação ilegível/ausente {ann_rel} ({exc.__class__.__name__})")
            continue
        except DatasetLayoutError as exc:
            result.problems.append(f"pares linha {n}: {ann_rel}: {exc}")
            continue

        subject_id = f"{DATASET}:{subject}"
        for start_s, end_s, source in segments:
            res = NTHU_LABEL_MAP.resolve(source, confirm_labels)
            if res.kind == "include":
                result.rows.append(ManifestRow(video=video_rel, subject_id=subject_id, label=res.label,
                                               source_label=source, start_s=start_s, end_s=end_s,
                                               dataset=DATASET, dataset_version=dataset_version))
            else:
                result.excluded.append(Excluded(video=video_rel, source_label=source, reason=res.reason,
                                                subject_id=subject_id, dataset=DATASET, kind=res.kind))

    for ann_rel, users in annotation_users.items():
        if len(users) > 1:
            result.problems.append(f"a mesma anotação {ann_rel} é usada por {len(users)} vídeos: {users}")
    return result
