"""Ingestão de ponta a ponta: descartes contados, estado temporal, dry-run, extração com relatório.

Vídeos/árvores fabricados e landmarker SIMULADO: testam a máquina de ingestão, não os datasets reais nem o
MediaPipe. Nenhum número daqui é desempenho de detecção.
"""

import json
from collections import Counter

import numpy as np
import pandas as pd
import pytest

import build_manifest
import extract_features
import validate_manifest
from dataset_adapters.common import ManifestRow, write_manifest
from dataset_adapters.uta_rldd import UTA_LABEL_MAP
from extract_features import CSV_COLUMNS, process_video
from features.schema import FEATURE_ORDER
from make_golden_fixture import build_points, full_landmarks

FACE = full_landmarks(build_points(1.0, 0.03, 0.0, 0.0))
BAD = [(0.5, 0.5, 0.0)] * 100                      # < 300 landmarks: rosto inválido
UTA_OK = UTA_LABEL_MAP.id


def touch(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def uta_root(root, subjects=("1", "2", "3", "4")):
    for s in subjects:
        for cls in ("0", "5", "10"):
            touch(root / "Fold1" / s / f"{cls}.mp4", f"{s}/{cls}".encode())
    return root


# ------------------------------------------------------------------ descartes contados por motivo

def test_every_discarded_frame_is_counted_by_reason_and_nothing_is_lost():
    times = [0, 100, 200, 300, 400, 500, 600, 700, 700, 800, 900, 1000, 1100]   # 700 repetido

    def fn(rgb, t):
        return None if t == 500 else BAD if t == 600 else FACE

    stats = Counter()
    rows = process_video([(t, None) for t in times], fn, "s", "v", 0, stats=stats)
    assert stats["frames_read"] == 13
    assert stats["bad_timestamp"] == 1               # 2º frame com t=700
    assert stats["no_face"] == 1 and stats["invalid_face"] == 1
    assert stats["window_warmup"] == 4               # 2 no início + 2 após perder o rosto (janela reinicia)
    assert stats["rows"] == len(rows) == 6
    discards = sum(stats[k] for k in extract_features.DISCARD_REASONS)
    assert stats["rows"] + discards == stats["frames_read"]          # nenhum frame some sem motivo


def test_backwards_timestamps_and_outside_segment_are_counted_not_zero_filled():
    stats = Counter()
    frames = [(0, None), (100, None), (200, None), (150, None), (300, None), (400, None), (500, None)]
    rows = process_video(frames, lambda rgb, t: FACE, "s", "v", lambda t: 1 if t >= 400 else None, stats=stats)
    assert stats["bad_timestamp"] == 1               # 150 < 200
    assert stats["outside_segment"] >= 1 and stats["rows"] == len(rows)
    assert all(r["t_ms"] >= 400 and r["label"] == 1 for r in rows)


def test_rows_are_traceable_to_the_original_frame():
    frames = [(i * 100, None, 3 * i) for i in range(20)]             # frame_index nativo != índice subamostrado
    meta = {"dataset": "uta_rldd", "relative_path": "Fold1/1/0.mp4", "source_label": "0"}
    rows = process_video(frames, lambda rgb, t: FACE, "uta_rldd:1", "uta_rldd:Fold1/1/0", 0, meta=meta)
    r = rows[0]
    assert r["t_ms"] == 200 and r["frame_index"] == 6
    assert (r["dataset"], r["relative_path"], r["source_label"]) == ("uta_rldd", "Fold1/1/0.mp4", "0")
    assert r["clip_id"] == "uta_rldd:Fold1/1/0#0" and set(r) == set(CSV_COLUMNS)


# ------------------------------------------------------------------ estado temporal

BLINK_EAR_THRESHOLD = 0.30   # o rosto sintético "fechado" (openness 0.1) tem EAR 0.255: abaixo de 0.30, não de 0.21


def blink_landmarks(t):
    closed = 2000 <= t < 3000                        # olhos fechados de 2 s a 3 s
    return full_landmarks(build_points(0.1 if closed else 1.0, 0.03, 0.0, 0.0))


def test_temporal_state_survives_a_label_change_inside_the_same_video():
    frames = [(i * 100, None) for i in range(60)]
    seg = process_video(frames, lambda rgb, t: blink_landmarks(t), "s", "v", lambda t: 0 if t < 3000 else 1,
                        ear_threshold=BLINK_EAR_THRESHOLD)
    const = process_video(frames, lambda rgb, t: blink_landmarks(t), "s", "v", 1, ear_threshold=BLINK_EAR_THRESHOLD)
    after = {r["t_ms"]: r for r in seg if r["t_ms"] >= 3000}
    ref = {r["t_ms"]: r for r in const if r["t_ms"] >= 3000}
    assert after and after.keys() == ref.keys()
    for t, row in after.items():                     # mudar o rótulo NÃO reinicia PERCLOS/piscadas
        assert [row[k] for k in FEATURE_ORDER] == [ref[t][k] for k in FEATURE_ORDER]
    assert max(r["perclos"] for r in after.values()) > 0             # o piscar de 2-3 s ainda pesa depois de 3 s

    fresh = process_video([f for f in frames if f[0] >= 3000], lambda rgb, t: blink_landmarks(t), "s", "v", 1,
                          ear_threshold=BLINK_EAR_THRESHOLD)
    assert max(r["perclos"] for r in fresh) == 0                     # reiniciar a cada rótulo perderia a evidência


def test_temporal_state_never_leaks_from_one_video_into_the_next():
    frames = [(i * 100, None) for i in range(60)]
    first = process_video(frames, lambda rgb, t: blink_landmarks(t), "s1", "v1", 1, ear_threshold=BLINK_EAR_THRESHOLD)
    second = process_video(frames, lambda rgb, t: full_landmarks(build_points(1.0, 0.03, 0.0, 0.0)), "s2", "v2", 0,
                           ear_threshold=BLINK_EAR_THRESHOLD)
    assert max(r["perclos"] for r in first) > 0
    assert all(r["perclos"] == 0 and r["msSinceLastBlink"] == -1 for r in second)   # nada do vídeo anterior


# ------------------------------------------------------------------ CLIs: dry-run e gate de rótulos

def test_build_manifest_dry_run_prints_layout_and_writes_nothing(tmp_path, capsys):
    root = uta_root(tmp_path / "raw")
    before = sorted(p.name for p in tmp_path.rglob("*"))
    assert build_manifest.main(["uta", "--raw", str(root), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "NÃO confirmado" in out and "simula a confirmação" in out and "dry-run" in out
    assert "confirmado pelo usuário: NAO - SIMULADO" in out            # a tabela não finge que houve confirmação
    assert '"subjects": 4' in out and "UNVERIFIED" in out and "RESULTADO: OK" in out
    assert sorted(p.name for p in tmp_path.rglob("*")) == before     # nada escrito


def test_build_manifest_refuses_unconfirmed_labels_and_wrong_confirmation(tmp_path):
    root = uta_root(tmp_path / "raw")
    out = tmp_path / "m" / "uta.csv"
    assert build_manifest.main(["uta", "--raw", str(root), "--out", str(out)]) == 1      # sem --confirm-labels
    assert not out.exists() and not (tmp_path / "m").exists()
    assert build_manifest.main(["uta", "--raw", str(root), "--out", str(out), "--confirm-labels", "uta_rldd/v0"]) == 1
    assert not out.exists()


def test_build_manifest_writes_manifest_and_summary_only_when_valid(tmp_path, capsys):
    root = uta_root(tmp_path / "raw")
    out = tmp_path / "m" / "uta.csv"
    args = ["uta", "--raw", str(root), "--out", str(out), "--confirm-labels", UTA_OK, "--dataset-version", "v-teste"]
    assert build_manifest.main(args) == 0
    summary = json.loads((out.parent / "dataset_summary.json").read_text(encoding="utf-8"))
    assert summary["subjects"] == 4 and summary["videos"] == 8 and summary["excluded_samples"] == 4
    assert summary["class_distribution"] == {"alert(0)": 4, "drowsy(1)": 4}
    assert summary["label_map_id"] == UTA_OK and {r["source_label"] for r in summary["label_map"] if r["included"]} == {"0", "10"}
    header = out.read_text(encoding="utf-8").splitlines()[0]
    assert header == "dataset,dataset_version,video,subject_id,label,source_label,start_s,end_s"
    assert "v-teste" in out.read_text(encoding="utf-8")
    assert "só então rode extract_features.py" in capsys.readouterr().out    # etapas separadas

    bad = tmp_path / "bad_raw"
    uta_root(bad)
    touch(bad / "awake" / "clip001.mp4", b"?")                               # layout inesperado
    out2 = tmp_path / "m2" / "uta.csv"
    assert build_manifest.main(["uta", "--raw", str(bad), "--out", str(out2), "--confirm-labels", UTA_OK]) == 1
    assert not out2.exists()                                                  # falha crítica: nada escrito


def test_nthu_requires_pairs_and_explicit_fps(tmp_path):
    with pytest.raises(SystemExit):
        build_manifest.main(["nthu", "--raw", str(tmp_path), "--dry-run"])


def test_validate_manifest_and_extract_dry_run_catch_a_deleted_video_before_extraction(tmp_path, capsys):
    root = uta_root(tmp_path / "raw")
    m = tmp_path / "uta.csv"
    assert build_manifest.main(["uta", "--raw", str(root), "--out", str(m), "--confirm-labels", UTA_OK]) == 0
    assert validate_manifest.main(["--manifest", str(m), "--raw", str(root)]) == 0
    assert extract_features.main(["--raw", str(root), "--manifest", str(m), "--dry-run"]) == 0   # sem landmarker/out

    (root / "Fold1" / "3" / "10.mp4").unlink()
    capsys.readouterr()
    assert validate_manifest.main(["--manifest", str(m), "--raw", str(root)]) == 1
    assert "arquivo ausente" in capsys.readouterr().out
    assert extract_features.main(["--raw", str(root), "--manifest", str(m), "--dry-run"]) == 1
    assert "Extração NAO iniciada" in capsys.readouterr().out


# ------------------------------------------------------------------ extração de ponta a ponta (landmarker simulado)

def write_avi(path, seed, n_frames=30):
    cv2 = pytest.importorskip("cv2")
    path.parent.mkdir(parents=True, exist_ok=True)
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (64, 48))
    rng = np.random.RandomState(seed)
    for _ in range(n_frames):
        w.write(rng.randint(0, 255, (48, 64, 3), dtype=np.uint8))
    w.release()


def varied_face(rgb, t):
    """Rosto sintético cujas features variam com o conteúdo do frame (vetores distintos entre vídeos)."""
    k = int(rgb.mean() * 10) % 40
    return full_landmarks(build_points(1.0, 0.03 + k / 400, 0.0, k / 800))


def make_extraction_case(tmp_path, monkeypatch, landmark_fn=varied_face, subjects=4):
    raw = tmp_path / "raw"
    rows = []
    for s in range(subjects):
        for label, name in ((0, "0"), (1, "10")):
            rel = f"Fold1/{s}/{name}.avi"
            write_avi(raw / rel, seed=s * 10 + label)
            rows.append(ManifestRow(rel, f"uta_rldd:{s}", label, name, dataset="uta_rldd", dataset_version="teste"))
    manifest = tmp_path / "m.csv"
    write_manifest(rows, manifest)
    monkeypatch.setattr(extract_features, "build_landmarker", lambda path: landmark_fn)
    args = ["--raw", str(raw), "--manifest", str(manifest), "--landmarker", "x.task", "--fps", "10", "--width", "0"]
    return raw, manifest, args


def test_extraction_writes_traceable_csv_report_and_no_partial_file(tmp_path, monkeypatch):
    _, _, args = make_extraction_case(tmp_path, monkeypatch)
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out)]) == 0
    assert out.exists() and not out.with_name(out.name + ".partial").exists()

    df = pd.read_csv(out)
    assert list(df.columns) == CSV_COLUMNS
    assert df["video_id"].nunique() == 8 and df["subject_id"].nunique() == 4
    assert set(df["dataset"]) == {"uta_rldd"} and df["relative_path"].str.startswith("Fold1/").all()
    assert (df["clip_id"] == df["video_id"] + "#" + df["label"].astype(str)).all()
    assert df["frame_index"].notna().all() and (df["frame_index"] >= 0).all()
    assert set(df["source_label"].astype(str)) == {"0", "10"}

    rep = json.loads((out.with_name("uta_extraction_report.json")).read_text(encoding="utf-8"))
    assert rep["status"] == "OK" and len(rep["per_video"]) == 8 and rep["features_csv_summary"]["subjects"] == 4
    t = rep["totals"]
    assert t["rows"] == len(df) and t["frames_read"] >= t["rows"]
    counted = sum(t.get(k, 0) for k in extract_features.DISCARD_REASONS)
    assert t["rows"] + counted == t["frames_read"]                            # tudo contabilizado
    assert {e["reason"] for e in rep["exclusions"]} >= {"window_warmup"}
    assert all({"reason", "count", "dataset", "subject", "video"} <= set(e) for e in rep["exclusions"])


def test_unreadable_video_aborts_by_default_and_never_leaves_a_final_csv(tmp_path, monkeypatch):
    raw, manifest, args = make_extraction_case(tmp_path, monkeypatch)
    (raw / "Fold1" / "3" / "10.avi").write_bytes(b"isto nao e um video")     # corrompido
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out)]) == 2
    assert not out.exists()                                                   # CSV parcial nunca tem o nome final
    assert out.with_name(out.name + ".partial").exists()
    rep = json.loads(out.with_name("uta_extraction_report.json").read_text(encoding="utf-8"))
    assert rep["status"] == "ABORTED" and "Fold1/3/10" in rep["errors"][0]


def test_skip_unreadable_records_the_exclusion_instead_of_hiding_it(tmp_path, monkeypatch):
    raw, manifest, args = make_extraction_case(tmp_path, monkeypatch, subjects=5)
    (raw / "Fold1" / "3" / "10.avi").write_bytes(b"isto nao e um video")
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out), "--skip-unreadable"]) == 0
    rep = json.loads(out.with_name("uta_extraction_report.json").read_text(encoding="utf-8"))
    lost = [e for e in rep["exclusions"] if e["video"].endswith("Fold1/3/10")]
    assert lost and lost[0]["reason"] in {"video_unreadable", "no_frames_read"} and lost[0]["subject"] == "uta_rldd:3"
    assert "uta_rldd:Fold1/3/10" not in set(pd.read_csv(out)["video_id"])


def test_video_without_a_single_usable_row_is_a_failure_not_a_silent_zero(tmp_path, monkeypatch):
    _, _, args = make_extraction_case(tmp_path, monkeypatch, landmark_fn=lambda rgb, t: None)
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out)]) == 2             # nenhuma linha utilizável
    rep = json.loads(out.with_name("uta_extraction_report.json").read_text(encoding="utf-8"))
    assert "no_usable_rows" in rep["errors"][0] and rep["totals"]["no_face"] > 0 and not out.exists()


def test_features_that_fail_validation_are_never_promoted_to_the_final_name(tmp_path, monkeypatch):
    identical = full_landmarks(build_points(1.0, 0.03, 0.0, 0.0))             # todos os sujeitos com os mesmos vetores
    _, _, args = make_extraction_case(tmp_path, monkeypatch, landmark_fn=lambda rgb, t: identical)
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out)]) == 1
    assert not out.exists() and out.with_name(out.name + ".partial").exists()
    rep = json.loads(out.with_name("uta_extraction_report.json").read_text(encoding="utf-8"))
    assert rep["status"] == "INVALID" and any("idênticos" in e for e in rep["errors"])


def test_extraction_refuses_an_invalid_manifest_before_touching_any_video(tmp_path, monkeypatch, capsys):
    raw, manifest, args = make_extraction_case(tmp_path, monkeypatch)
    text = manifest.read_text(encoding="utf-8").replace("uta_rldd:0", "uta_rldd:00", 1)   # cria ids duvidosos
    manifest.write_text(text, encoding="utf-8")
    out = tmp_path / "f" / "uta.csv"
    assert extract_features.main(args + ["--out", str(out)]) == 1
    assert "identidade de sujeito duvidosa" in capsys.readouterr().out
    assert not out.exists() and not out.with_name(out.name + ".partial").exists()   # nem começou
