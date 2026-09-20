"""Validação estrutural do manifesto e do CSV de features: dado ambíguo = ERRO, nunca correção silenciosa.

Árvores/CSVs fabricados: testam o comportamento do validador, não a correspondência com datasets oficiais.
"""

import numpy as np
import pandas as pd

from dataset_adapters.common import Excluded, ManifestRow, read_manifest_rows, write_manifest
from dataset_adapters.validation import format_report, validate_features, validate_rows
from features.schema import FEATURE_ORDER


def touch(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def R(video, subject, label, start=None, end=None, dataset="d"):
    return ManifestRow(video=video, subject_id=subject, label=label, source_label=str(label),
                       start_s=start, end_s=end, dataset=dataset)


def good_rows(tmp_path, n=4):
    """n sujeitos x 2 classes, arquivos com conteúdo único."""
    rows = []
    for s in range(n):
        for label, name in ((0, "a"), (1, "d")):
            rel = f"s{s}/{name}.mp4"
            touch(tmp_path / rel, f"{s}-{name}".encode())
            rows.append(R(rel, f"d:s{s}", label))
    return rows


def errors_of(rows, raw, **kw):
    rep = validate_rows(rows, raw, **kw)
    return rep, "\n".join(rep.errors)


def test_valid_manifest_passes_and_summary_has_every_pretraining_field(tmp_path):
    rows = good_rows(tmp_path)
    excl = [Excluded(video="s0/x.mp4", source_label="5", reason="intermediário", subject_id="d:s0", dataset="d")]
    rep = validate_rows(rows, tmp_path, excluded=excl)
    assert rep.ok and rep.errors == []
    s = rep.summary
    assert s["datasets"] == ["d"] and s["subjects"] == 4 and s["videos"] == 8 and s["clips"] == 8
    assert s["frames"] is None                                       # sem --probe não inventa contagem de frames
    assert s["included_samples"] == 8 and s["excluded_samples"] == 1 and s["labels"] == [0, 1]
    assert s["class_distribution"] == {"alert(0)": 4, "drowsy(1)": 4}
    assert s["subjects_per_class"] == {"alert(0)": 4, "drowsy(1)": 4}
    assert s["videos_per_class"] == {"alert(0)": 4, "drowsy(1)": 4}
    assert s["exclusion_reasons"] == {"5: intermediário": 1}


def test_missing_empty_and_outside_files_fail(tmp_path):
    rows = good_rows(tmp_path)
    (tmp_path / rows[0].video).unlink()
    touch(tmp_path / rows[1].video, b"")
    rows.append(R("../fora.mp4", "d:s9", 0))
    _, text = errors_of(rows, tmp_path)
    assert "arquivo ausente" in text and "arquivo vazio" in text and "fora de --raw" in text


def test_invalid_fields_duplicates_overlaps_and_mixed_subjects_fail(tmp_path):
    rows = good_rows(tmp_path)
    rows.append(R(rows[2].video, "d:s1", 0))                          # linha duplicada (mesmo vídeo e segmento)
    rows.append(R("s0/a.mp4", "d:s2", 0, 0.0, 5.0))                   # mesmo vídeo, outro sujeito (e sobrepõe)
    rows.append(ManifestRow(video="s3/a.mp4", subject_id="d:s3", label=2, source_label="2"))
    rows.append(ManifestRow(video="s3/d.mp4", subject_id="  ", label=1, source_label="1"))
    rows.append(R("s3/d.mp4", "d:s3", 1, 5.0, 2.0))                   # segmento invertido
    _, text = errors_of(rows, tmp_path)
    for expected in ("linha duplicada", "mistura de sujeitos", "sobrepostos", "label 2 inválido",
                     "subject_id ausente", "segmento vazio/invertido"):
        assert expected in text, expected


def test_doubtful_subject_identity_fails_safe_but_distinct_numeric_ids_pass(tmp_path):
    rows = good_rows(tmp_path)
    touch(tmp_path / "x/a.mp4", b"xa")
    rows.append(R("x/a.mp4", "d:s01", 0))                             # 's01' vs 's1' => possível mesma pessoa
    rep, text = errors_of(rows, tmp_path)
    assert "identidade de sujeito duvidosa" in text and "d:s01" in text

    ok_rows = []
    for s in ("001", "002", "010", "100"):
        for label, name in ((0, "a"), (1, "d")):
            touch(tmp_path / f"n{s}/{name}.mp4", f"{s}{name}".encode())
            ok_rows.append(R(f"n{s}/{name}.mp4", f"d:{s}", label))
    assert validate_rows(ok_rows, tmp_path).ok


def test_identical_files_under_different_paths_fail(tmp_path):
    rows = good_rows(tmp_path)
    touch(tmp_path / "copia/a.mp4", (tmp_path / "s0/a.mp4").read_bytes())      # mesmo conteúdo, outro caminho
    rows.append(R("copia/a.mp4", "d:s7", 0))
    _, text = errors_of(rows, tmp_path)
    assert "arquivos idênticos" in text and "copia/a.mp4" in text


def test_class_without_samples_or_subjects_fails_and_few_subjects_warn(tmp_path):
    only_alert = [r for r in good_rows(tmp_path) if r.label == 0]
    rep, text = errors_of(only_alert, tmp_path)
    assert "sonolento(1) sem amostras" in text and "confirmado" in text

    one_drowsy = [r for r in good_rows(tmp_path) if r.label == 0 or r.subject_id == "d:s0"]
    _, text = errors_of(one_drowsy, tmp_path)
    assert "sonolento(1) com 1 sujeito" in text

    three = good_rows(tmp_path, n=3)
    rep = validate_rows(three, tmp_path)
    assert rep.ok and any("apenas 3 sujeitos" in w for w in rep.warnings)


def test_same_subject_id_in_two_datasets_requires_a_namespace(tmp_path):
    rows = good_rows(tmp_path)
    touch(tmp_path / "o/a.mp4", b"other")
    rows.append(R("o/a.mp4", "d:s0", 0, dataset="outro"))
    _, text = errors_of(rows, tmp_path)
    assert "mais de um dataset" in text


def test_probe_detects_unreadable_empty_and_mismatched_annotation_duration(tmp_path):
    rows = good_rows(tmp_path)
    rows[0] = R(rows[0].video, "d:s0", 0, 0.0, 60.0)                  # anotação de 60 s...
    info = {"s0/a.mp4": {"frames": 100, "fps": 10.0, "duration_s": 10.0},   # ...num vídeo de 10 s
            "s1/a.mp4": None}                                          # ilegível

    def stub(path):
        rel = path.relative_to(tmp_path.resolve()).as_posix()
        if rel in info and info[rel] is None:
            raise OSError("não abriu")
        return info.get(rel, {"frames": 300, "fps": 10.0, "duration_s": 30.0})

    rep, text = errors_of(rows, tmp_path, probe=True, probe_fn=stub)
    assert "anotação vai até 60.0s" in text and "vídeo ilegível/sem frames" in text
    assert rep.summary["frames"] == 100 + 300 * 6                      # 8 vídeos - 1 ilegível; um com 100 frames

    rows = good_rows(tmp_path)
    rows[0] = R(rows[0].video, "d:s0", 0, 0.0, 5.0)
    rep = validate_rows(rows, tmp_path, probe=True, probe_fn=lambda p: {"frames": 300, "fps": 10.0, "duration_s": 30.0})
    assert rep.ok and any("trecho final" in w for w in rep.warnings)   # aviso, não erro
    rep = validate_rows(rows, tmp_path, probe=True, probe_fn=lambda p: (_ for _ in ()).throw(ValueError("frames=0")))
    assert not rep.ok


def test_manifest_reader_collects_problems_and_keeps_optional_columns_optional(tmp_path):
    m = tmp_path / "m.csv"
    m.write_text("video,subject_id,label,start_s,end_s\n"
                 "a.mp4,s1,0,,\n"
                 "b.mp4,s2,7,,\n"                                      # label inválido
                 "c.mp4,s3,1,nan,4\n"                                  # tempo não finito
                 "d.mp4,s4,1,x,4\n", encoding="utf-8")                 # tempo ilegível
    rows, problems = read_manifest_rows(m)
    assert [r.video for r in rows] == ["a.mp4"] and rows[0].dataset == "unspecified"
    assert len(problems) == 3
    m.write_text("video,label\na.mp4,1\n", encoding="utf-8")
    assert read_manifest_rows(m) == ([], ["manifesto sem colunas obrigatórias: ['subject_id']"])


def test_written_manifest_round_trips_with_provenance_columns(tmp_path):
    rows = [ManifestRow("s/a.mp4", "d:s", 1, "10", 1.0, 2.0, "uta_rldd", "v1")]
    write_manifest(rows, tmp_path / "m.csv")
    back, problems = read_manifest_rows(tmp_path / "m.csv")
    assert problems == [] and back == rows


def test_report_text_is_safe_for_the_windows_console(tmp_path):
    rep, _ = errors_of(good_rows(tmp_path)[:2], tmp_path)
    format_report(rep).encode("cp1252")                                # não levanta UnicodeEncodeError


# ------------------------------------------------------------------ CSV de features

def features_df(n_subjects=4, rows_per=20, seed=0):
    rng = np.random.RandomState(seed)
    out = []
    for s in range(n_subjects):
        for label in (0, 1):
            for i in range(rows_per):
                out.append({"dataset": "d", "subject_id": f"d:s{s}", "video_id": f"d:s{s}/v{label}",
                            "t_ms": 100 * i, **dict(zip(FEATURE_ORDER, rng.normal(0.3, 0.05, len(FEATURE_ORDER)))),
                            "label": label})
    return pd.DataFrame(out)


def feature_errors(df):
    rep = validate_features(df, FEATURE_ORDER)
    return rep, "\n".join(rep.errors)


def test_valid_feature_csv_passes_with_counts():
    rep, _ = feature_errors(features_df())
    assert rep.ok
    assert rep.summary["subjects"] == 4 and rep.summary["videos"] == 8 and rep.summary["clips"] == 8
    assert rep.summary["rows_per_class"] == {"alert(0)": 80, "drowsy(1)": 80}


def test_feature_csv_rejects_duplicate_or_backwards_timestamps_and_bad_values():
    df = features_df()
    dup = pd.concat([df, df.iloc[[0]]], ignore_index=True)
    assert "repetido" in feature_errors(dup)[1]

    back = df.copy()
    back.loc[5, "t_ms"] = 0                                            # regride dentro do vídeo
    _, text = feature_errors(back)
    assert "repetido" in text or "fora de ordem" in text

    for bad in (np.nan, np.inf):
        nan = df.copy()
        nan.loc[3, "ear"] = bad
        assert "NaN/Infinity" in feature_errors(nan)[1]
    neg = df.copy()
    neg.loc[2, "t_ms"] = -5
    assert "t_ms inválido" in feature_errors(neg)[1]


def test_feature_csv_rejects_a_video_owned_by_two_subjects_and_doubtful_ids():
    df = features_df()
    mixed = df.copy()
    mixed.loc[mixed["subject_id"] == "d:s1", "video_id"] = "d:s0/v0"    # vídeo de s0 atribuído a s1 também
    assert "mais de um sujeito" in feature_errors(mixed)[1]

    doubt = df.copy()
    doubt.loc[doubt["subject_id"] == "d:s1", "subject_id"] = "d:s01"
    doubt = pd.concat([doubt, df[df["subject_id"] == "d:s0"].assign(subject_id="d:s00", video_id="d:s00/x")])
    _, text = feature_errors(doubt)
    assert "identidade de sujeito duvidosa" in text and "d:s00" in text   # 's00' e 's0' normalizam igual


def test_feature_csv_rejects_identical_vectors_across_subjects_but_only_warns_within_one():
    df = features_df()
    cross = df.copy()
    cross.loc[cross.index[45], FEATURE_ORDER] = cross.loc[cross.index[3], FEATURE_ORDER].to_numpy()   # s1 == s0
    assert cross.loc[cross.index[45], "subject_id"] != cross.loc[cross.index[3], "subject_id"]
    assert "idênticos em sujeitos diferentes" in feature_errors(cross)[1]

    within = df.copy()
    within.loc[within.index[25], FEATURE_ORDER] = within.loc[within.index[3], FEATURE_ORDER].to_numpy()  # mesmo sujeito s0
    assert within.loc[within.index[25], "subject_id"] == within.loc[within.index[3], "subject_id"]
    rep, _ = feature_errors(within)
    assert rep.ok and any("mesmo sujeito" in w for w in rep.warnings)


def test_feature_csv_needs_both_classes_with_enough_subjects_and_required_columns():
    df = features_df()
    assert "sonolento(1) sem linhas" in feature_errors(df[df["label"] == 0])[1]
    one = df[(df["label"] == 0) | (df["subject_id"] == "d:s0")]
    assert "sonolento(1) com 1 sujeito" in feature_errors(one)[1]
    assert "colunas ausentes" in feature_errors(df.drop(columns=["video_id"]))[1]
    assert "sem linhas" in feature_errors(df.iloc[0:0])[1]
