import numpy as np
import pytest

from extract_features import iter_video_frames, process_video, read_manifest
from features.schema import FEATURE_ORDER
from make_golden_fixture import build_points, full_landmarks

FACE = full_landmarks(build_points(1.0, 0.03, 0.0, 0.0))


def frames(n, fps=10, start=0):
    return [(start + int(i * 1000 / fps), None) for i in range(n)]


def test_state_does_not_leak_between_videos():
    """Regressão: o extrator antigo era compartilhado; do 2o vídeo em diante NENHUMA linha era gerada."""
    def ok(rgb, t):
        return FACE

    v1 = process_video(frames(60), ok, "s1", "v1", 0)
    v2 = process_video(frames(60), ok, "s2", "v2", 1)  # relógio recomeça em 0
    assert len(v1) > 0 and len(v2) == len(v1)
    assert v2[0]["msSinceLastBlink"] == -1 and v2[0]["perclos"] == 0.0


def test_rows_carry_ids_label_and_all_features_in_schema_order():
    rows = process_video(frames(20), lambda rgb, t: FACE, "sujeito7", "videoA", 1)
    r = rows[0]
    assert r["subject_id"] == "sujeito7" and r["video_id"] == "videoA" and r["label"] == 1
    assert all(k in r for k in FEATURE_ORDER)
    assert r["t_ms"] == 200  # 3o frame a 10 fps: janela mínima de 3 frames


def test_no_face_resets_window_and_invalid_face_is_skipped():
    seq = [FACE] * 6 + [None] + [FACE] * 6
    it = iter(seq)
    rows = process_video(frames(len(seq)), lambda rgb, t: next(it), "s", "v", 0)
    times = [r["t_ms"] for r in rows]
    assert 600 not in times  # sem rosto -> sem linha
    assert 700 not in times and 800 not in times  # janela recomeça: precisa de 3 frames de novo
    assert 900 in times

    bad = [(0.5, 0.5, 0.0)] * 100  # < 300 landmarks -> inválido -> ignorado
    assert process_video(frames(20), lambda rgb, t: bad, "s", "v", 0) == []


def test_manifest_validation(tmp_path):
    m = tmp_path / "m.csv"
    m.write_text("video,subject_id,label\na.mp4,s1,2\n", encoding="utf-8")
    with pytest.raises(ValueError, match="label"):
        read_manifest(m, tmp_path)
    m.write_text("video,subject_id,label\na.mp4,,1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="subject_id"):
        read_manifest(m, tmp_path)
    m.write_text("video,subject_id,label,start_s,end_s\na.mp4,s1,1,2,8\n", encoding="utf-8")
    e = read_manifest(m, tmp_path)[0]
    assert (e.subject_id, e.label, e.start_s, e.end_s) == ("s1", 1, 2.0, 8.0)


def test_iter_video_frames_subsamples_30fps_to_target(tmp_path):
    cv2 = pytest.importorskip("cv2")
    path = tmp_path / "v.avi"
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 30.0, (64, 48))
    for _ in range(90):  # 3 s a 30 fps
        w.write(np.zeros((48, 64, 3), dtype=np.uint8))
    w.release()
    out = list(iter_video_frames(path, target_fps=10.0, width=32))
    assert 28 <= len(out) <= 31  # aprox. 10 fps x 3 s
    ts = [t for t, _ in out]
    assert ts == sorted(ts) and out[0][1].shape == (24, 32, 3)


def test_manifest_rejects_paths_outside_raw_and_non_finite_times(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    m = tmp_path / "m.csv"
    for bad in ("../secret.mp4", "/etc/passwd", "C:/Windows/x.mp4"):
        m.write_text(f"video,subject_id,label\n{bad},s1,1\n", encoding="utf-8")
        with pytest.raises(ValueError, match="fora de --raw"):
            read_manifest(m, raw)
    m.write_text("video,subject_id,label,start_s,end_s\na.mp4,s1,1,nan,5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="finito"):
        read_manifest(m, raw)
