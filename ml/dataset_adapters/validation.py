"""Validação estrutural: manifesto (ANTES da extração) e CSV de features (ANTES do treino).

Princípio: dado ambíguo é ERRO, nunca corrigido em silêncio. Dúvida sobre identidade de sujeito, vídeo
duplicado, arquivo idêntico sob dois caminhos, timestamps repetidos: FALHA (fail-safe), porque cada um
desses casos é uma via de vazamento entre treino e teste.

    manifest -> validate_rows()      (existência, tamanho, ids, duplicatas, sobreposição, classes, --probe)
    features -> validate_features()  (ids, timestamps, mistura de sujeitos, vetores duplicados, classes)

Nada aqui é pesado por padrão; `probe=True` abre cada vídeo com OpenCV só para ler contagem de frames/fps.
"""

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from .common import Excluded, ManifestRow, relative_posix, DatasetLayoutError

MIN_SUBJECTS_PER_CLASS = 2        # abaixo disso o split por sujeito não consegue as duas classes nos dois lados
WARN_SUBJECTS_PER_CLASS = 4
SIGNATURE_BYTES = 1 << 20         # 1 MiB do início + 1 MiB do fim (+ tamanho): assinatura barata de arquivo
DURATION_TOLERANCE_S = 1.0
ProbeFn = Callable[[Path], Dict[str, float]]


@dataclass
class ValidationReport:
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    summary: Dict[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def raise_if_errors(self) -> None:
        if self.errors:
            shown = "; ".join(self.errors[:8]) + (f"; (+{len(self.errors) - 8} erros)" if len(self.errors) > 8 else "")
            raise ValueError(f"validação falhou: {shown}")


def format_report(rep: ValidationReport) -> str:
    """Texto ASCII-seguro (o console Windows cp1252 não imprime setas/símbolos)."""
    lines = [f"ERRO: {e}" for e in rep.errors] + [f"AVISO: {w}" for w in rep.warnings]
    lines.append(json.dumps(rep.summary, indent=2, ensure_ascii=False))
    lines.append("RESULTADO: " + ("OK" if rep.ok else f"FALHOU ({len(rep.errors)} erros)"))
    return "\n".join(lines)


def subject_key(subject_id: str) -> str:
    """Chave de identidade: minúsculas, só alfanumérico, sem zeros à esquerda em números.
    'subject01' e 'subject1' (e '01'/'1') são a MESMA pessoa em potencial => colisão => falha.
    '001', '002', '010' continuam distintos (1, 2, 10)."""
    alnum = re.sub(r"[^a-z0-9]", "", subject_id.lower())
    return re.sub(r"(?<!\d)0+(?=\d)", "", alnum)


def file_signature(path: Path) -> str:
    """tamanho + sha256 dos primeiros e últimos 1 MiB. Igual => tratado como o mesmo arquivo."""
    size = path.stat().st_size
    h = hashlib.sha256(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(SIGNATURE_BYTES))
        if size > SIGNATURE_BYTES:
            f.seek(max(size - SIGNATURE_BYTES, SIGNATURE_BYTES))
            h.update(f.read(SIGNATURE_BYTES))
    return h.hexdigest()


def probe_video(path: Path) -> Dict[str, float]:
    """frames/fps/duração via OpenCV (sem decodificar). Levanta OSError se ilegível ou sem frames."""
    try:
        import cv2
    except ImportError as exc:
        raise OSError("opencv (cv2) indisponível: instale ml/requirements para usar --probe") from exc
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise OSError("não abriu (corrompido ou codec não suportado)")
        frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    finally:
        cap.release()
    if frames <= 0 or fps <= 0 or not math.isfinite(fps):
        raise OSError(f"sem frames/fps legíveis (frames={frames}, fps={fps})")
    return {"frames": frames, "fps": fps, "duration_s": frames / fps}


def _spans(rows: Iterable[ManifestRow]) -> List[tuple]:
    return sorted((r.start_s if r.start_s is not None else -math.inf,
                   r.end_s if r.end_s is not None else math.inf) for r in rows)


def summarize(rows: Sequence[ManifestRow], excluded: Sequence[Excluded], frames: Optional[int]) -> Dict[str, object]:
    """Resumo pré-treino. 'included/excluded_samples' contam LINHAS DE MANIFESTO (vídeo ou segmento),
    não frames; `frames` só existe com --probe (contagem nativa dos vídeos, antes de subamostrar)."""
    def per_class(fn) -> Dict[str, int]:
        return {name: fn([r for r in rows if r.label == lab]) for lab, name in ((0, "alert(0)"), (1, "drowsy(1)"))}
    reasons = Counter(f"{e.source_label}: {e.reason}" for e in excluded)
    return {
        "datasets": sorted({r.dataset for r in rows} | {e.dataset for e in excluded}),
        "subjects": len({r.subject_id for r in rows}),
        "videos": len({r.video for r in rows}),
        "clips": len({(r.video, r.label) for r in rows}),
        "frames": frames,
        "included_samples": len(rows),
        "excluded_samples": len(excluded),
        "labels": sorted({r.label for r in rows}),
        "class_distribution": per_class(len),
        "subjects_per_class": per_class(lambda rs: len({r.subject_id for r in rs})),
        "videos_per_class": per_class(lambda rs: len({r.video for r in rs})),
        "exclusion_reasons": dict(reasons),
        "unit_note": "amostras = linhas do manifesto (vídeo/segmento), não frames",
    }


def validate_rows(rows: Sequence[ManifestRow], raw: Path, *, excluded: Sequence[Excluded] = (),
                  problems: Sequence[str] = (), warnings: Sequence[str] = (), probe: bool = False,
                  probe_fn: Optional[ProbeFn] = None) -> ValidationReport:
    raw = raw.resolve()
    errors: List[str] = list(problems)
    warns: List[str] = list(warnings)
    by_video: Dict[str, List[ManifestRow]] = defaultdict(list)
    seen = set()

    for i, r in enumerate(rows, start=1):
        where = f"linha {i} ({r.video or '?'})"
        if r.label not in (0, 1):
            errors.append(f"{where}: label {r.label!r} inválido")
        if not r.subject_id.strip():
            errors.append(f"{where}: subject_id ausente")
        if not r.video.strip():
            errors.append(f"{where}: video ausente")
            continue
        for name, v in (("start_s", r.start_s), ("end_s", r.end_s)):
            if v is not None and (not math.isfinite(v) or v < 0):
                errors.append(f"{where}: {name}={v} inválido")
        if r.start_s is not None and r.end_s is not None and r.end_s <= r.start_s:
            errors.append(f"{where}: segmento vazio/invertido [{r.start_s}, {r.end_s})")
        key = (r.video, r.start_s, r.end_s)
        if key in seen:
            errors.append(f"{where}: linha duplicada (mesmo vídeo e mesmo segmento)")
        seen.add(key)
        by_video[r.video].append(r)

    files: Dict[str, Path] = {}
    for video, vrows in by_video.items():
        try:
            path = (raw / video).resolve()
            relative_posix(path, raw)
        except DatasetLayoutError:
            errors.append(f"{video}: caminho fora de --raw")
            continue
        if not path.is_file():
            errors.append(f"{video}: arquivo ausente")
            continue
        if path.stat().st_size == 0:
            errors.append(f"{video}: arquivo vazio (0 bytes)")
            continue
        files[video] = path
        if len({r.subject_id for r in vrows}) > 1:
            errors.append(f"{video}: o mesmo vídeo aparece com sujeitos diferentes "
                          f"{sorted({r.subject_id for r in vrows})} (mistura de sujeitos)")
        if len({r.dataset for r in vrows}) > 1:
            errors.append(f"{video}: o mesmo vídeo aparece em datasets diferentes")
        spans = _spans(vrows)
        if any(b[0] < a[1] for a, b in zip(spans, spans[1:])):
            errors.append(f"{video}: segmentos/linhas sobrepostos")

    ids_by_key: Dict[str, set] = defaultdict(set)
    datasets_by_subject: Dict[str, set] = defaultdict(set)
    for r in rows:
        if r.subject_id.strip():
            ids_by_key[subject_key(r.subject_id)].add(r.subject_id)
            datasets_by_subject[r.subject_id].add(r.dataset)
    for key, ids in sorted(ids_by_key.items()):
        if len(ids) > 1:
            errors.append(f"identidade de sujeito duvidosa: {sorted(ids)} normalizam para '{key}' "
                          f"(podem ser a mesma pessoa; unifique ou renomeie de forma inequívoca)")
    for subject, dsets in sorted(datasets_by_subject.items()):
        if len(dsets) > 1:
            errors.append(f"sujeito '{subject}' aparece em mais de um dataset {sorted(dsets)}: use namespace")

    signatures: Dict[str, List[str]] = defaultdict(list)
    for video, path in files.items():
        signatures[file_signature(path)].append(video)
    for vids in signatures.values():
        if len(vids) > 1:
            errors.append(f"arquivos idênticos sob caminhos diferentes (possível duplicata/mesma pessoa): {sorted(vids)}")

    subjects_by_class: Dict[int, set] = {0: set(), 1: set()}
    for r in rows:
        if r.label in subjects_by_class:
            subjects_by_class[r.label].add(r.subject_id)
    for lab, name in ((0, "alerta(0)"), (1, "sonolento(1)")):
        n = len(subjects_by_class[lab])
        if n == 0:
            errors.append(f"classe {name} sem amostras (mapa de rótulos confirmado? ver --confirm-labels)")
        elif n < MIN_SUBJECTS_PER_CLASS:
            errors.append(f"classe {name} com {n} sujeito(s): o split por sujeito exige >= {MIN_SUBJECTS_PER_CLASS}")
        elif n < WARN_SUBJECTS_PER_CLASS:
            warns.append(f"classe {name} com apenas {n} sujeitos: métricas de teste terão pouco poder estatístico")

    frames_total: Optional[int] = None
    if probe:
        fn = probe_fn or probe_video
        frames_total = 0
        for video, path in files.items():
            try:
                info = fn(path)
            except (OSError, ValueError) as exc:
                errors.append(f"{video}: vídeo ilegível/sem frames ({exc})")
                continue
            frames_total += int(info["frames"])
            ends = [r.end_s for r in by_video[video] if r.end_s is not None]
            if ends:
                last, duration = max(ends), info["duration_s"]
                if last > duration + DURATION_TOLERANCE_S:
                    errors.append(f"{video}: anotação vai até {last:.1f}s mas o vídeo dura {duration:.1f}s (fps errado?)")
                elif last < duration - DURATION_TOLERANCE_S:
                    warns.append(f"{video}: anotação termina em {last:.1f}s, vídeo dura {duration:.1f}s "
                                 f"(o trecho final não gera amostras)")

    return ValidationReport(errors, warns, summarize(rows, excluded, frames_total))


def validate_features(df, feature_columns: Sequence[str]) -> ValidationReport:
    """Valida o CSV de features antes do treino (df = pandas.DataFrame). Vazamento indireto incluso."""
    import numpy as np
    import pandas as pd

    errors: List[str] = []
    warns: List[str] = []
    required = ["subject_id", "video_id", "t_ms", "label"]
    missing = [c for c in required + list(feature_columns) if c not in df.columns]
    if missing:
        return ValidationReport([f"colunas ausentes no CSV: {missing}"], [], {})
    if df.empty:
        return ValidationReport(["CSV sem linhas"], [], {})

    if not np.isfinite(df[list(feature_columns)].to_numpy(dtype=float)).all():
        errors.append("features com NaN/Infinity — corrija a extração, não preencha com 0")
    t = pd.to_numeric(df["t_ms"], errors="coerce")
    if t.isna().any() or (t < 0).any() or not np.isfinite(t.fillna(0)).all():
        errors.append("t_ms inválido (ausente, negativo ou não finito)")
    if not set(df["label"].unique()) <= {0, 1}:
        errors.append("label deve ser 0 (alerta) ou 1 (sonolento)")

    videos = df["video_id"].astype(str)
    subjects = df["subject_id"].astype(str)
    per_video = df.assign(_v=videos, _s=subjects).groupby("_v")["_s"].nunique()
    for v in per_video[per_video > 1].index[:5]:
        errors.append(f"video_id '{v}' pertence a mais de um sujeito (mistura de sujeitos / ids inconsistentes)")
    dup_ts = df.assign(_v=videos).duplicated(subset=["_v", "t_ms"]).sum()
    if dup_ts:
        errors.append(f"{int(dup_ts)} linhas com (video_id, t_ms) repetido: frames duplicados")
    for v, grp in df.assign(_v=videos).groupby("_v")["t_ms"]:
        if not grp.is_monotonic_increasing:
            errors.append(f"timestamps fora de ordem em '{v}'")
            break

    ids_by_key: Dict[str, set] = defaultdict(set)
    for s in subjects.unique():
        ids_by_key[subject_key(s)].add(s)
    for key, ids in sorted(ids_by_key.items()):
        if len(ids) > 1:
            errors.append(f"identidade de sujeito duvidosa: {sorted(ids)} normalizam para '{key}'")

    hashed = pd.util.hash_pandas_object(df[list(feature_columns)], index=False)
    by_hash = df.assign(_h=hashed, _s=subjects, _v=videos).groupby("_h").agg(s=("_s", "nunique"), v=("_v", "nunique"))
    cross_subject = int((by_hash["s"] > 1).sum())
    cross_video = int(((by_hash["v"] > 1) & (by_hash["s"] == 1)).sum())
    if cross_subject:
        errors.append(f"{cross_subject} vetores de features idênticos em sujeitos diferentes "
                      f"(arquivo/frames duplicados sob outra identidade)")
    if cross_video:
        warns.append(f"{cross_video} vetores idênticos em vídeos diferentes do mesmo sujeito")

    for lab, name in ((0, "alerta(0)"), (1, "sonolento(1)")):
        n = subjects[df["label"] == lab].nunique()
        if n == 0:
            errors.append(f"classe {name} sem linhas")
        elif n < MIN_SUBJECTS_PER_CLASS:
            errors.append(f"classe {name} com {n} sujeito(s): split por sujeito inviável")
        elif n < WARN_SUBJECTS_PER_CLASS:
            warns.append(f"classe {name} com apenas {n} sujeitos")

    summary = {"rows": int(len(df)), "subjects": int(subjects.nunique()), "videos": int(videos.nunique()),
               "clips": int(len(df.assign(_v=videos)[["_v", "label"]].drop_duplicates())),
               "rows_per_class": {"alert(0)": int((df["label"] == 0).sum()), "drowsy(1)": int((df["label"] == 1).sum())},
               "subjects_per_class": {"alert(0)": int(subjects[df["label"] == 0].nunique()),
                                      "drowsy(1)": int(subjects[df["label"] == 1].nunique())}}
    return ValidationReport(errors, warns, summary)
