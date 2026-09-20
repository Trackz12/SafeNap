"""Extrai o vetor de 18 features de vídeos rotulados -> CSV (uma linha = uma janela).

Significado de uma linha: as 18 features calculadas no instante `t_ms` de UM vídeo
de UM sujeito, usando a janela deslizante dos últimos 10 frames (~1 s a 10 fps) e o
estado de PERCLOS/piscada dos últimos 60 s daquele vídeo. `label` é o rótulo do
vídeo/segmento vindo do MANIFESTO, nunca inferido do nome do arquivo.

Rastreabilidade (toda linha aponta para o dado original): dataset, subject_id, video_id, clip_id
(= video_id#label), relative_path (vídeo relativo a --raw), frame_index (índice do frame no vídeo
original), t_ms, label, source_label (rótulo original; vazio em vídeos segmentados, onde o rótulo por
instante vem do manifesto).

Fidelidade ao frontend (paridade verificada por shared/feature_golden.json):
  - MediaPipe FaceLandmarker (API `tasks`, o mesmo modelo .task do navegador), modo VIDEO;
  - geometria/EAR/ratios de features/metrics.py == frameAnalyzer.ts;
  - janela, PERCLOS, piscadas: features/metrics.py + features/blink.py == featureExtractor.ts + DetectionEngine;
  - amostragem a `--fps` (padrão 10, igual ao loop do navegador), para que "10 frames" seja ~1 s.
Diferenças inevitáveis: o limiar de EAR offline é fixo (`--ear-threshold`), não a calibração
por pessoa; o navegador processa 320 px de largura (use --width 320 para aproximar).

Estado temporal: NOVO por vídeo físico (nunca passa de um vídeo para outro). Dentro do MESMO vídeo com
vários segmentos/rótulos (várias linhas do manifesto), o vídeo é lido uma vez e o estado NÃO reinicia
quando o rótulo muda.

Integridade: nada é convertido em 0. Cada frame descartado é CONTADO por motivo (sem rosto, rosto inválido,
timestamp inválido, aquecimento da janela, fora de segmento, feature não finita) por vídeo, no
`<out>_extraction_report.json`. Vídeo ilegível / sem frames / sem nenhuma linha utilizável ABORTA a
extração (ou, com --skip-unreadable, é registrado como exclusão). O CSV é escrito em `<out>.partial` e só
recebe o nome final se passar a validação (ml/dataset_adapters/validation.py): um dataset incompleto
nunca se disfarça de completo.

Manifesto (CSV): dataset,dataset_version,video,subject_id,label,source_label,start_s,end_s (gerado por
build_manifest.py; só video,subject_id,label são obrigatórios num manifesto escrito à mão). Várias linhas
do mesmo vídeo = rótulos por segmento.

Uso (etapa SEPARADA da montagem do manifesto e do treino):
    python scripts/extract_features.py --raw ../data/raw/uta --manifest ../data/manifests/uta.csv --dry-run
    python scripts/extract_features.py --raw ../data/raw/uta --manifest ../data/manifests/uta.csv \\
        --landmarker ../frontend/public/mediapipe/models/face_landmarker.task --out ../data/features/uta.csv
"""

import argparse
import csv
import hashlib
import json
import math
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple, Union

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dataset_adapters.common import read_manifest_rows  # noqa: E402
from dataset_adapters.validation import format_report, validate_features, validate_rows  # noqa: E402
from features import BlinkTracker, FeatureExtractor, analyze_frame  # noqa: E402
from features.schema import FEATURE_ORDER, WINDOW  # noqa: E402

CSV_COLUMNS = (["dataset", "subject_id", "video_id", "clip_id", "relative_path", "frame_index", "t_ms"]
               + FEATURE_ORDER + ["label", "source_label"])
DEFAULT_EAR_THRESHOLD = 0.21  # limiar fixo validado no CEW (reports/ear_validation); NÃO é calibração individual
# contadores de descarte por frame (tudo que NÃO vira linha e não é erro fatal)
DISCARD_REASONS = ("no_face", "invalid_face", "bad_timestamp", "window_warmup", "non_finite_features",
                   "outside_segment")
Point = Tuple[float, float, float]
LandmarkFn = Callable[[object, int], Optional[Sequence[Point]]]
Labeler = Callable[[int], Optional[int]]


@dataclass(frozen=True)
class ManifestEntry:
    video: Path
    subject_id: str
    label: int
    start_s: Optional[float] = None
    end_s: Optional[float] = None
    # "<dataset>:<caminho relativo sem extensão>": único entre sujeitos E datasets (o nome do arquivo
    # sozinho colide, ex. UTA "0"/"5"/"10" repete em todo sujeito)
    video_id: str = ""
    dataset: str = ""
    dataset_version: str = ""
    source_label: str = ""


def read_manifest(manifest: Path, raw_dir: Path) -> List[ManifestEntry]:
    """Lê o manifesto para extração. Levanta ValueError no primeiro erro (a validação completa e
    detalhada é `validate_rows`, executada antes em main())."""
    entries: List[ManifestEntry] = []
    with open(manifest, newline="", encoding="utf-8") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            label = (row.get("label") or "").strip()
            subject = (row.get("subject_id") or "").strip()
            if label not in ("0", "1"):
                raise ValueError(f"manifesto linha {n}: label deve ser 0 ou 1, veio {label!r}")
            if not subject:
                raise ValueError(f"manifesto linha {n}: subject_id vazio (necessário para split por pessoa)")
            rel = row.get("video") or ""
            video = (raw_dir / rel).resolve()
            if not rel or not video.is_relative_to(raw_dir.resolve()):
                raise ValueError(f"manifesto linha {n}: 'video' vazio ou fora de --raw ({rel!r})")
            times = []
            for col in ("start_s", "end_s"):
                v = float(row[col]) if row.get(col) else None
                if v is not None and not math.isfinite(v):
                    raise ValueError(f"manifesto linha {n}: {col} não finito")
                times.append(v)
            dataset = (row.get("dataset") or "").strip()
            stem = video.relative_to(raw_dir.resolve()).with_suffix("").as_posix()
            entries.append(ManifestEntry(
                video=video, subject_id=subject, label=int(label), start_s=times[0], end_s=times[1],
                video_id=f"{dataset}:{stem}" if dataset else stem, dataset=dataset,
                dataset_version=(row.get("dataset_version") or "").strip(),
                source_label=(row.get("source_label") or "").strip()))
    return entries


Segment = Tuple[Optional[float], Optional[float], int]  # (start_s, end_s exclusivo, label)


def label_at(segments: Sequence[Segment]) -> Labeler:
    """t_ms -> label do segmento que o contém (None = fora de qualquer segmento: não gera linha)."""
    def resolve(t_ms: int) -> Optional[int]:
        for start, end, label in segments:
            if (start is None or t_ms >= start * 1000) and (end is None or t_ms < end * 1000):
                return label
        return None
    return resolve


def group_by_video(entries: Sequence[ManifestEntry]) -> List[Tuple[ManifestEntry, Optional[Labeler]]]:
    """Uma tarefa por vídeo físico. Várias linhas do mesmo vídeo (rótulos por segmento, ex. NTHU) viram UMA
    passada sobre o vídeo inteiro com rótulo por instante — o estado de PERCLOS/piscadas não reinicia a
    cada troca de rótulo, como não reiniciaria em produção. Linha única mantém o comportamento antigo."""
    by_video: Dict[Path, List[ManifestEntry]] = {}
    for e in entries:
        by_video.setdefault(e.video, []).append(e)
    jobs: List[Tuple[ManifestEntry, Optional[Labeler]]] = []
    for group in by_video.values():
        first = group[0]
        if len(group) == 1:
            jobs.append((first, None))
            continue
        if len({e.subject_id for e in group}) != 1:
            raise ValueError(f"{first.video.name}: linhas do mesmo vídeo com sujeitos diferentes")
        spans = sorted((e.start_s if e.start_s is not None else -math.inf,
                        e.end_s if e.end_s is not None else math.inf) for e in group)
        if any(b[0] < a[1] for a, b in zip(spans, spans[1:])):
            raise ValueError(f"{first.video.name}: segmentos sobrepostos no manifesto")
        jobs.append((first, label_at([(e.start_s, e.end_s, e.label) for e in group])))
    return jobs


def iter_video_frames(path: Path, target_fps: float, start_s: Optional[float] = None,
                      end_s: Optional[float] = None, width: Optional[int] = None,
                      with_index: bool = False) -> Iterator[tuple]:
    """Gera (t_ms, frame RGB) — ou (t_ms, frame RGB, frame_index) com with_index — subamostrado a target_fps.
    `frame_index` é o índice do frame no vídeo ORIGINAL (antes de subamostrar)."""
    import cv2
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise OSError(f"não abriu {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    next_t = 0.0
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t_ms = cap.get(cv2.CAP_PROP_POS_MSEC) or (idx * 1000.0 / fps)
            frame_index = idx
            idx += 1
            if start_s is not None and t_ms < start_s * 1000:
                continue
            if end_s is not None and t_ms > end_s * 1000:
                break
            if t_ms + 1e-6 < next_t:
                continue
            next_t = t_ms + 1000.0 / target_fps
            if width:
                h = max(1, round(frame.shape[0] * width / frame.shape[1]))
                frame = cv2.resize(frame, (width, h))
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            yield (int(t_ms), rgb, frame_index) if with_index else (int(t_ms), rgb)
    finally:
        cap.release()


def build_landmarker(model_path: Path) -> LandmarkFn:
    """FaceLandmarker (API `tasks`) em modo VIDEO; a antiga `mp.solutions.face_mesh` não existe mais."""
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision

    options = mp_vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.3,   # iguais a frontend/src/vision/mediapipe.ts
        min_face_presence_confidence=0.3,
        min_tracking_confidence=0.5,
    )
    landmarker = mp_vision.FaceLandmarker.create_from_options(options)

    def run(rgb: object, t_ms: int) -> Optional[Sequence[Point]]:
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect_for_video(image, t_ms)
        if not result.face_landmarks:
            return None
        return [(p.x, p.y, p.z) for p in result.face_landmarks[0]]

    return run


def process_video(frames: Iterable[tuple], landmark_fn: LandmarkFn, subject_id: str,
                  video_id: str, label: Union[int, Labeler],
                  ear_threshold: float = DEFAULT_EAR_THRESHOLD, stats: Optional[Counter] = None,
                  meta: Optional[Dict[str, object]] = None) -> List[Dict[str, object]]:
    """Um vídeo -> linhas. Estado (janela, PERCLOS, piscadas) é NOVO por vídeo — nunca vaza entre vídeos.
    `label` pode ser uma função t_ms -> label|None (rótulo por segmento): frames fora de segmento
    atualizam o estado mas não geram linha. `frames` = (t_ms, rgb) ou (t_ms, rgb, frame_index).
    `stats` (Counter) acumula frames_read, rows e cada motivo de descarte (DISCARD_REASONS)."""
    counts = stats if stats is not None else Counter()
    meta = meta or {}
    extractor = FeatureExtractor()
    tracker = BlinkTracker(ear_threshold)
    rows: List[Dict[str, object]] = []
    last_t: Optional[float] = None
    for item in frames:
        t_ms, rgb = item[0], item[1]
        frame_index = item[2] if len(item) > 2 else ""
        counts["frames_read"] += 1
        # timestamp inválido/regressivo corromperia PERCLOS e piscadas: descarta e conta
        if not isinstance(t_ms, (int, float)) or not math.isfinite(t_ms) or t_ms < 0 \
                or (last_t is not None and t_ms <= last_t):
            counts["bad_timestamp"] += 1
            continue
        last_t = t_ms
        landmarks = landmark_fn(rgb, t_ms)
        if landmarks is None:                      # ≙ detectionEngine.processNoFace()
            counts["no_face"] += 1
            tracker.face_lost(t_ms)
            extractor.reset()
            continue
        analysis = analyze_frame(landmarks)
        if analysis is None:                       # rosto inválido: o navegador também ignora o frame
            counts["invalid_face"] += 1
            continue
        tracker.update(analysis["ear"], t_ms)
        features = extractor.extract(analysis, t_ms, tracker.perclos(t_ms), tracker.blink_rate(t_ms),
                                     tracker.last_blink_at)
        if features is None:
            counts["window_warmup"] += 1
            continue
        if not all(math.isfinite(features[k]) for k in FEATURE_ORDER):
            counts["non_finite_features"] += 1
            continue
        row_label = label(t_ms) if callable(label) else label
        if row_label is None:
            counts["outside_segment"] += 1
            continue
        counts["rows"] += 1
        rows.append({"dataset": meta.get("dataset", ""), "subject_id": subject_id, "video_id": video_id,
                     "clip_id": f"{video_id}#{row_label}", "relative_path": meta.get("relative_path", ""),
                     "frame_index": frame_index, "t_ms": t_ms,
                     **{k: features[k] for k in FEATURE_ORDER}, "label": row_label,
                     "source_label": meta.get("source_label", "")})
    return rows


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fail_reason(stats: Counter) -> Optional[str]:
    if stats["frames_read"] == 0:
        return "no_frames_read"           # ilegível/corrompido/vazio
    if stats["rows"] == 0:
        return "no_usable_rows"           # frames lidos, mas nenhuma linha utilizável
    return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Extrai features de vídeos rotulados (manifesto)")
    p.add_argument("--raw", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--landmarker", type=Path, help="face_landmarker.task (obrigatório sem --dry-run)")
    p.add_argument("--out", type=Path, help="CSV de features (obrigatório sem --dry-run)")
    p.add_argument("--fps", type=float, default=WINDOW["targetFps"])
    p.add_argument("--width", type=int, default=320)
    p.add_argument("--ear-threshold", type=float, default=DEFAULT_EAR_THRESHOLD)
    p.add_argument("--dry-run", action="store_true", help="só valida o manifesto e mostra o resumo; não extrai")
    p.add_argument("--probe", action="store_true", help="valida abrindo cada vídeo (frames/fps/duração)")
    p.add_argument("--skip-unreadable", action="store_true",
                   help="registra vídeos ilegíveis/sem linhas como exclusão em vez de abortar")
    args = p.parse_args(argv)

    # 1) validação estrutural ANTES de qualquer processamento pesado
    rows, parse_problems = read_manifest_rows(args.manifest)
    report = validate_rows(rows, args.raw, problems=parse_problems, probe=args.probe)
    print(format_report(report))
    if not report.ok:
        print("Extração NAO iniciada: corrija o manifesto (o pipeline não corrige dados ambíguos).")
        return 1
    if args.dry_run:
        print("[dry-run] nada foi extraído.")
        return 0
    if not args.out or not args.landmarker:
        p.error("--out e --landmarker são obrigatórios sem --dry-run")

    entries = read_manifest(args.manifest, args.raw)
    landmark_fn = build_landmarker(args.landmarker)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    partial = args.out.with_name(args.out.name + ".partial")
    raw_root = args.raw.resolve()

    totals: Counter = Counter()
    per_video: List[Dict[str, object]] = []
    exclusions: List[Dict[str, object]] = []
    aborted: Optional[str] = None
    with open(partial, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for e, segment_label in group_by_video(entries):
            multi = segment_label is not None
            stats: Counter = Counter()
            meta = {"dataset": e.dataset, "relative_path": e.video.relative_to(raw_root).as_posix(),
                    "source_label": "" if multi else e.source_label}
            failure: Optional[str] = None
            video_rows: List[Dict[str, object]] = []
            try:
                frames = iter_video_frames(e.video, args.fps, None if multi else e.start_s,
                                           None if multi else e.end_s, args.width, with_index=True)
                video_rows = process_video(frames, landmark_fn, e.subject_id, e.video_id,
                                           segment_label if multi else e.label, args.ear_threshold,
                                           stats=stats, meta=meta)
            except OSError as exc:
                failure = f"video_unreadable: {exc}"
            failure = failure or _fail_reason(stats)
            writer.writerows(video_rows)
            totals.update(stats)
            per_video.append({"video_id": e.video_id, "subject_id": e.subject_id, "dataset": e.dataset,
                              "label": "por segmento" if multi else e.label, "stats": dict(stats),
                              "failure": failure})
            for reason in DISCARD_REASONS:
                if stats[reason]:
                    exclusions.append({"reason": reason, "count": stats[reason], "dataset": e.dataset,
                                       "subject": e.subject_id, "video": e.video_id})
            print(f"[{'FALHA' if failure else 'ok'}] {e.video_id} sujeito={e.subject_id} "
                  f"label={'por segmento' if multi else e.label}: {stats['rows']} linhas de {stats['frames_read']} frames"
                  + (f" ({failure})" if failure else ""))
            if failure:
                exclusions.append({"reason": failure.split(":")[0], "count": 1, "dataset": e.dataset,
                                   "subject": e.subject_id, "video": e.video_id})
                if not args.skip_unreadable:
                    aborted = f"{e.video_id}: {failure}"
                    break

    report_path = args.out.with_name(args.out.stem + "_extraction_report.json")

    def write_report(status: str, features_summary: Optional[dict], errors: List[str]) -> None:
        report_path.write_text(json.dumps({
            "status": status, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "manifest": args.manifest.name, "manifest_sha256": _sha256(args.manifest),
            "config": {"fps": args.fps, "width": args.width, "ear_threshold": args.ear_threshold,
                       "skip_unreadable": args.skip_unreadable},
            "totals": dict(totals), "exclusions": exclusions, "per_video": per_video,
            "features_csv_summary": features_summary, "errors": errors}, indent=2, ensure_ascii=False),
            encoding="utf-8")

    if aborted:
        write_report("ABORTED", None, [aborted])
        print(f"ABORTADO: {aborted}. CSV parcial em {partial} (NAO utilizavel). Relatorio: {report_path}")
        return 2

    import pandas as pd
    df = pd.read_csv(partial)
    feat = validate_features(df, FEATURE_ORDER)
    if not feat.ok:
        write_report("INVALID", feat.summary, feat.errors)
        print(format_report(feat))
        print(f"CSV reprovado na validação: mantido como {partial}. Relatorio: {report_path}")
        return 1
    partial.replace(args.out)
    write_report("OK", feat.summary, [])
    print(format_report(feat))
    print(f"\n[ok] {totals['rows']} linhas de {totals['frames_read']} frames -> {args.out}\n"
          f"[ok] relatorio -> {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
