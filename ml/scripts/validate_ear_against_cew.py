"""Valida a classificação olho-aberto/olho-fechado por EAR contra o dataset
público CEW (Closed Eyes in the Wild, NUAA), com rótulos humanos reais —
não um cenário sintético.

Réplica em Python da MESMA fórmula usada em produção
(`frontend/src/vision/frameAnalyzer.ts`): FaceLandmarker do MediaPipe (478
landmarks, o mesmo modelo `face_landmarker.task` usado no navegador via
@mediapipe/tasks-vision), EAR com distâncias 3D e 4 pares verticais por
olho, combinação robusta dos dois olhos.

O dataset NÃO é distribuído com este repositório (licença do CEW proíbe
redistribuição) — baixe manualmente e aponte --data-dir para a pasta
extraída. Ver reports/README.md para as instruções e o link.

Uso:
    cd ml && .venv/Scripts/python.exe scripts/validate_ear_against_cew.py \
        --data-dir /caminho/para/dataset_B_FacialImages \
        --model /caminho/para/face_landmarker.task
"""

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

# ---------------------------------------------------------------------------
# Mesma geometria de frameAnalyzer.ts (EYE_OUTER_LEFT/RIGHT, LEFT_EYE/RIGHT_EYE,
# EYE_DISAGREEMENT_RATIO) — mantida em paridade manual com o TypeScript.
# ---------------------------------------------------------------------------

LEFT_EYE = {"h1": 33, "h2": 133, "verticals": [(158, 153), (160, 144), (159, 145), (157, 154)]}
RIGHT_EYE = {"h1": 263, "h2": 362, "verticals": [(387, 373), (385, 380), (386, 374), (388, 390)]}
EYE_DISAGREEMENT_RATIO = 0.55


def dist3d(a, b) -> float:
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def eye_ear(landmarks, eye: dict) -> float:
    horizontal = dist3d(landmarks[eye["h1"]], landmarks[eye["h2"]])
    if horizontal <= 1e-6:
        return 0.0
    vertical_sum = sum(dist3d(landmarks[u], landmarks[l]) for u, l in eye["verticals"])
    return vertical_sum / (len(eye["verticals"]) * horizontal)


def combine_eyes(ear_l: float, ear_r: float) -> float:
    """Pose frontal apenas (rostos do CEW são frontais) — mesma lógica de
    combineEyes() em frameAnalyzer.ts para yawRatio ~ 0."""
    lo, hi = min(ear_l, ear_r), max(ear_l, ear_r)
    if hi > 1e-6 and lo / hi < EYE_DISAGREEMENT_RATIO:
        return hi
    return (ear_l + ear_r) / 2


def compute_ear_for_image(detector, image_path: Path) -> float | None:
    img = cv2.imread(str(image_path))
    if img is None:
        return None
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = detector.detect(mp_image)
    if not result.face_landmarks:
        return None
    landmarks = result.face_landmarks[0]
    ear_l = eye_ear(landmarks, LEFT_EYE)
    ear_r = eye_ear(landmarks, RIGHT_EYE)
    return combine_eyes(ear_l, ear_r)


def main() -> None:
    parser = argparse.ArgumentParser(description="Valida EAR contra o dataset CEW")
    parser.add_argument("--data-dir", type=Path, required=True,
                        help="Pasta com subpastas ClosedFace/ e OpenFace/ (variante 100x100 do CEW)")
    parser.add_argument("--model", type=Path, required=True, help="Caminho do face_landmarker.task")
    parser.add_argument("--thresholds", type=float, nargs="+", default=[0.21, 0.25],
                        help="Limiares de EAR a avaliar (default: 0.21 calibrado sintético, 0.25 literatura)")
    args = parser.parse_args()

    closed_dir = args.data_dir / "ClosedFace"
    open_dir = args.data_dir / "OpenFace"
    if not closed_dir.is_dir() or not open_dir.is_dir():
        sys.exit(f"Esperado ClosedFace/ e OpenFace/ dentro de {args.data_dir}")

    base_options = mp_python.BaseOptions(model_asset_path=str(args.model))
    options = mp_vision.FaceLandmarkerOptions(base_options=base_options, num_faces=1)
    detector = mp_vision.FaceLandmarker.create_from_options(options)

    samples: list[dict] = []  # {path, ground_truth_closed, ear}
    no_face_count = {"closed": 0, "open": 0}

    for label_name, folder, is_closed in (("closed", closed_dir, True), ("open", open_dir, False)):
        # set() + resolve(): no Windows, glob("*.jpg") e glob("*.JPG") batem
        # nos MESMOS arquivos (filesystem case-insensitive) e duplicariam
        # cada imagem na contagem sem essa deduplicação.
        seen = {p.resolve() for p in folder.glob("*.jpg")}
        seen |= {p.resolve() for p in folder.glob("*.png")}
        files = sorted(seen)
        print(f"[{label_name}] {len(files)} imagens")
        for i, f in enumerate(files):
            ear = compute_ear_for_image(detector, f)
            if ear is None:
                no_face_count[label_name] += 1
                continue
            samples.append({"path": str(f.name), "ground_truth_closed": is_closed, "ear": ear})
            if (i + 1) % 200 == 0:
                print(f"  ... {i + 1}/{len(files)}")

    print(f"\nTotal com landmarks detectados: {len(samples)}")
    print(f"Sem rosto detectado: closed={no_face_count['closed']} open={no_face_count['open']}")

    results_by_threshold = {}
    for threshold in args.thresholds:
        tp = fp = tn = fn = 0
        for s in samples:
            predicted_closed = s["ear"] < threshold
            if s["ground_truth_closed"] and predicted_closed:
                tp += 1
            elif not s["ground_truth_closed"] and predicted_closed:
                fp += 1
            elif not s["ground_truth_closed"] and not predicted_closed:
                tn += 1
            else:
                fn += 1
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        accuracy = (tp + tn) / len(samples) if samples else 0.0
        results_by_threshold[str(threshold)] = {
            "tp": tp, "fp": fp, "tn": tn, "fn": fn,
            "precision": round(precision, 4), "recall": round(recall, 4),
            "f1": round(f1, 4), "accuracy": round(accuracy, 4),
        }
        print(f"\nLimiar {threshold}: acc={accuracy:.4f} precisão={precision:.4f} recall={recall:.4f} F1={f1:.4f}")
        print(f"  VP={tp} FP={fp} VN={tn} FN={fn}")

    report = {
        "methodology": (
            "MediaPipe FaceLandmarker (mesmo modelo .task do frontend, 478 landmarks) rodando via "
            "mediapipe.tasks.python (Python), EAR calculado com a mesma fórmula/índices de "
            "frontend/src/vision/frameAnalyzer.ts (distância 3D, 4 pares verticais por olho, combine_eyes "
            "para pose frontal). Dataset: CEW (Closed Eyes in the Wild, NUAA), variante 100x100, "
            "ground truth = pasta (ClosedFace/OpenFace). Imagens sem rosto detectado pelo MediaPipe são "
            "excluídas da matriz de confusão e reportadas separadamente (limitação do detector, não do EAR)."
        ),
        "caveat": (
            "Isto usa um limiar FIXO global para todos os sujeitos do dataset — mais pessimista que a "
            "produção real, que calibra o limiar por pessoa (fase aberta+fechada, ver docs/DETECTION.md). "
            "Um usuário real, calibrado individualmente, deve ter acurácia igual ou melhor que a reportada aqui."
        ),
        "dataset": "CEW (Closed Eyes in the Wild), NUAA — variante 100x100, não redistribuída neste repositório",
        "total_images_closed_folder": len(list(closed_dir.glob("*"))),
        "total_images_open_folder": len(list(open_dir.glob("*"))),
        "no_face_detected": no_face_count,
        "samples_used": len(samples),
        "results_by_threshold": results_by_threshold,
    }

    out_dir = Path(__file__).resolve().parent.parent.parent / "reports" / "ear_validation"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "cew_results.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    md = [
        "# Validação do EAR contra dados humanos reais (CEW)",
        "",
        report["methodology"],
        "",
        f"> **Ressalva importante**: {report['caveat']}",
        "",
        f"- Imagens na pasta ClosedFace/: {report['total_images_closed_folder']}",
        f"- Imagens na pasta OpenFace/: {report['total_images_open_folder']}",
        f"- Sem rosto detectado pelo MediaPipe: {no_face_count['closed']} (closed) / {no_face_count['open']} (open)",
        f"- Amostras usadas na matriz de confusão: {report['samples_used']}",
        "",
    ]
    for threshold, r in results_by_threshold.items():
        md += [
            f"## Limiar EAR = {threshold}",
            "",
            "| | Previsto: fechado | Previsto: aberto |",
            "|---|---|---|",
            f"| **Real: fechado** | VP={r['tp']} | FN={r['fn']} |",
            f"| **Real: aberto** | FP={r['fp']} | VN={r['tn']} |",
            "",
            f"Acurácia: **{r['accuracy']}** · Precisão: **{r['precision']}** · Recall: **{r['recall']}** · F1: **{r['f1']}**",
            "",
        ]
    with open(out_dir / "cew_results.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

    print(f"\nRelatório escrito em {out_dir}")


if __name__ == "__main__":
    main()
