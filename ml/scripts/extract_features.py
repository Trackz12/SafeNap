"""Extrai features de vídeos de datasets usando o FeatureExtractor.

Processa vídeos (com MediaPipe para landmarks) ou arquivos JSON de landmarks
e gera um CSV com as 18 features + label.

Uso:
    python scripts/extract_features.py --raw ../data/raw/uta --out ../data/features/uta.csv
    python scripts/extract_features.py --raw ../data/raw/nthu --out ../data/features/nthu.csv
"""

import argparse
import json
import sys
import csv
from pathlib import Path

try:
    import cv2
    import mediapipe as mp
except ImportError:
    cv2 = None
    mp = None

from features.metrics import FeatureExtractor, compute_frame_features
from features.schema import FEATURE_ORDER


def extract_from_video(video_path: Path, label: int, fe: FeatureExtractor, writer: csv.DictWriter,
                       max_frames: int = 3000) -> int:
    """Extrai features de um vídeo usando MediaPipe FaceMesh.

    Returns: número de linhas gravadas.
    """
    if cv2 is None or mp is None:
        print("pip install opencv-python-headless mediapipe")
        return 0

    mp_face_mesh = mp.solutions.face_mesh
    rows = 0
    with mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as face_mesh:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            print(f"[skip] não abriu {video_path.name}")
            return 0

        frame_idx = 0
        fps = max(1, int(cap.get(cv2.CAP_PROP_FPS) or 30))
        while cap.isOpened():
            ok, frame = cap.read()
            if not ok or frame_idx >= max_frames:
                break
            frame_idx += 1

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            results = face_mesh.process(rgb)
            if not results.multi_face_landmarks:
                continue

            lm = results.multi_face_landmarks[0]
            points = [(p.x, p.y, p.z) for p in lm.landmark]
            frame_features = compute_frame_features(points)
            t_ms = int(frame_idx * 1000 / fps)

            # blink rate / perclos: sem detecção de piscada no pipeline offline,
            # aproximamos com base no EAR do frame.
            ear = frame_features['ear']
            blink_rate = 0.0
            perclos = 1.0 if ear < 0.15 else 0.0

            fv = fe.extract(frame_features, t_ms, perclos, blink_rate, None)
            if fv:
                row = {k: fv[k] for k in FEATURE_ORDER}
                row['label'] = label
                writer.writerow(row)
                rows += 1

        cap.release()

    return rows


def extract_from_json(json_path: Path, label: int, fe: FeatureExtractor, writer: csv.DictWriter) -> int:
    """Extrai features de um arquivo JSON de landmarks (formato: list of {landmarks, t})."""
    data = json.loads(json_path.read_text())
    rows = 0
    for entry in data:
        points = [(p['x'], p['y'], p['z']) for p in entry['landmarks']]
        frame_features = compute_frame_features(points)
        t_ms = int(entry.get('t', 0))
        perclos = 1.0 if frame_features['ear'] < 0.15 else 0.0
        fv = fe.extract(frame_features, t_ms, perclos, 0.0, None)
        if fv:
            row = {k: fv[k] for k in FEATURE_ORDER}
            row['label'] = label
            writer.writerow(row)
            rows += 1
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Extrai features de vídeos/landmarks")
    parser.add_argument("--raw", type=Path, required=True, help="pasta raw do dataset")
    parser.add_argument("--out", type=Path, required=True, help="CSV de saída")
    parser.add_argument("--label-map", default='{"awake":0,"low":1,"high":1,"drowsy":1}',
                        help='mapa de classe→label (JSON)')
    args = parser.parse_args()

    label_map = json.loads(args.label_map)
    args.out.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = FEATURE_ORDER + ['label']
    fe = FeatureExtractor()

    with open(args.out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        total = 0

        for video in sorted(args.raw.rglob('*')):
            if video.suffix.lower() not in {'.mp4', '.avi', '.mov', '.json'}:
                continue
            label = 1
            for key, val in label_map.items():
                if key.lower() in video.name.lower() or key.lower() in str(video.parent).lower():
                    label = val
                    break
            if video.suffix.lower() == '.json':
                total += extract_from_json(video, label, fe, writer)
            else:
                total += extract_from_video(video, label, fe, writer)
            print(f"[ok] {video.name} (label={label})")

    print(f"\n[ok] {total} linhas → {args.out}")


if __name__ == "__main__":
    main()
