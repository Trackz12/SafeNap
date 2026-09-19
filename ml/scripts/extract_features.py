"""Extrai o vetor de 18 features de vídeos rotulados → CSV (uma linha = uma janela).

Significado de uma linha: as 18 features calculadas no instante `t_ms` de UM vídeo
de UM sujeito, usando a janela deslizante dos últimos 10 frames (~1 s a 10 fps) e o
estado de PERCLOS/piscada dos últimos 60 s daquele vídeo. `label` é o rótulo do
vídeo/segmento (1 = sonolento, 0 = alerta) vindo do MANIFESTO, nunca inferido do
nome do arquivo. `subject_id` permite separar treino/teste por PESSOA (linhas
consecutivas de um mesmo vídeo são quase idênticas; misturá-las entre treino e
teste infla as métricas).

Fidelidade ao frontend (paridade verificada por shared/feature_golden.json):
  - MediaPipe FaceLandmarker (API `tasks`, o mesmo modelo .task do navegador), modo VIDEO;
  - geometria/EAR/ratios de features/metrics.py == frameAnalyzer.ts;
  - janela, PERCLOS, piscadas: features/metrics.py + features/blink.py == featureExtractor.ts + DetectionEngine;
  - amostragem a `--fps` (padrão 10, igual ao loop do navegador), para que "10 frames" seja ~1 s.
Diferenças inevitáveis: o limiar de EAR offline é fixo (`--ear-threshold`), não a calibração
por pessoa; o navegador processa 320 px de largura (use --width 320 para aproximar).

Manifesto (CSV): video,subject_id,label[,start_s,end_s]   (video relativo a --raw)

Uso:
    python scripts/extract_features.py --raw ../data/raw/uta --manifest manifest.csv \
        --landmarker ../frontend/public/mediapipe/models/face_landmarker.task --out ../data/features/uta.csv
"""

import argparse
import csv
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from features import BlinkTracker, FeatureExtractor, analyze_frame  # noqa: E402
from features.schema import FEATURE_ORDER, WINDOW  # noqa: E402

META_COLUMNS = ["subject_id", "video_id", "t_ms"]
DEFAULT_EAR_THRESHOLD = 0.21  # limiar fixo validado no CEW (reports/ear_validation); NÃO é calibração individual
Point = Tuple[float, float, float]
LandmarkFn = Callable[[object, int], Optional[Sequence[Point]]]


@dataclass(frozen=True)
class ManifestEntry:
    video: Path
    subject_id: str
    label: int
    start_s: Optional[float] = None
    end_s: Optional[float] = None


def read_manifest(manifest: Path, raw_dir: Path) -> List[ManifestEntry]:
    entries: List[ManifestEntry] = []
    with open(manifest, newline="", encoding="utf-8") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            label = row.get("label", "").strip()
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
            entries.append(ManifestEntry(video=video, subject_id=subject, label=int(label),
                                         start_s=times[0], end_s=times[1]))
    return entries


def iter_video_frames(path: Path, target_fps: float, start_s: Optional[float] = None,
                      end_s: Optional[float] = None, width: Optional[int] = None) -> Iterator[Tuple[int, object]]:
    """Gera (t_ms, frame RGB) subamostrado a target_fps."""
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
            yield int(t_ms), cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
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


def process_video(frames: Iterable[Tuple[int, object]], landmark_fn: LandmarkFn, subject_id: str,
                  video_id: str, label: int, ear_threshold: float = DEFAULT_EAR_THRESHOLD) -> List[Dict[str, object]]:
    """Um vídeo → linhas. Estado (janela, PERCLOS, piscadas) é NOVO por vídeo — nunca vaza entre vídeos."""
    extractor = FeatureExtractor()
    tracker = BlinkTracker(ear_threshold)
    rows: List[Dict[str, object]] = []
    for t_ms, rgb in frames:
        landmarks = landmark_fn(rgb, t_ms)
        if landmarks is None:                      # ≙ detectionEngine.processNoFace()
            tracker.face_lost(t_ms)
            extractor.reset()
            continue
        analysis = analyze_frame(landmarks)
        if analysis is None:                       # rosto inválido: o navegador também ignora o frame
            continue
        tracker.update(analysis["ear"], t_ms)
        features = extractor.extract(analysis, t_ms, tracker.perclos(t_ms), tracker.blink_rate(t_ms),
                                     tracker.last_blink_at)
        if features is None:
            continue
        rows.append({"subject_id": subject_id, "video_id": video_id, "t_ms": t_ms,
                     **{k: features[k] for k in FEATURE_ORDER}, "label": label})
    return rows


def main() -> None:
    p = argparse.ArgumentParser(description="Extrai features de vídeos rotulados (manifesto)")
    p.add_argument("--raw", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--landmarker", type=Path, required=True, help="face_landmarker.task")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--fps", type=float, default=WINDOW["targetFps"])
    p.add_argument("--width", type=int, default=320)
    p.add_argument("--ear-threshold", type=float, default=DEFAULT_EAR_THRESHOLD)
    args = p.parse_args()

    entries = read_manifest(args.manifest, args.raw)
    landmark_fn = build_landmarker(args.landmarker)
    args.out.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=META_COLUMNS + FEATURE_ORDER + ["label"])
        writer.writeheader()
        for e in entries:
            frames = iter_video_frames(e.video, args.fps, e.start_s, e.end_s, args.width)
            rows = process_video(frames, landmark_fn, e.subject_id, e.video.stem, e.label, args.ear_threshold)
            writer.writerows(rows)
            total += len(rows)
            print(f"[ok] {e.video.name} sujeito={e.subject_id} label={e.label}: {len(rows)} linhas")
    print(f"\n[ok] {total} linhas → {args.out}")


if __name__ == "__main__":
    main()
