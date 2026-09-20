"""Adaptadores de dataset: rótulos UNVERIFIED até confirmar, problemas coletados, ids sem colisão.

AVISO: as árvores de diretório abaixo são FABRICADAS conforme a estrutura DOCUMENTADA nos adaptadores.
Testes sintéticos validam o COMPORTAMENTO do adaptador; NÃO validam a correspondência do adaptador com o
dataset oficial (UTA-RLDD / NTHU-DDD). Essa só se verifica com os arquivos reais (dry-run, ver
docs/DATASET_PIPELINE.md).
"""

import pytest

from dataset_adapters.common import DatasetLayoutError, write_manifest
from dataset_adapters.nthu_ddd import NTHU_LABEL_MAP, build_nthu_manifest, segments_from_frame_labels
from dataset_adapters.uta_rldd import UTA_LABEL_MAP, build_uta_manifest
from dataset_adapters.validation import subject_key
from extract_features import group_by_video, label_at, process_video, read_manifest
from make_golden_fixture import build_points, full_landmarks

FACE = full_landmarks(build_points(1.0, 0.03, 0.0, 0.0))
UTA_OK = UTA_LABEL_MAP.id
NTHU_OK = NTHU_LABEL_MAP.id


def touch(path, content=b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def uta_tree(root, subjects=("11", "12", "13")):
    for s in subjects:
        for cls in ("0", "5", "10"):
            touch(root / "Fold1" / s / f"{cls}.mp4", f"{s}-{cls}".encode())


# --------------------------------------------------------------------------- UTA-RLDD

def test_uta_labels_are_unverified_and_not_included_until_confirmed(tmp_path):
    uta_tree(tmp_path)
    res = build_uta_manifest(tmp_path)                       # sem --confirm-labels
    assert res.rows == []                                    # nada entra automaticamente
    kinds = {}
    for e in res.excluded:
        kinds[e.kind] = kinds.get(e.kind, 0) + 1
    assert kinds == {"unverified": 6, "exclude": 3}
    assert all("UNVERIFIED" in e.reason for e in res.excluded if e.kind == "unverified")

    wrong = build_uta_manifest(tmp_path, confirm_labels="uta_rldd/v0")   # id de outra versão do mapa
    assert wrong.rows == []


def test_uta_maps_labels_explicitly_after_confirmation(tmp_path):
    uta_tree(tmp_path)
    res = build_uta_manifest(tmp_path, confirm_labels=UTA_OK, dataset_version="teste")
    by = {(r.subject_id, r.source_label): r.label for r in res.rows}
    assert by[("uta_rldd:11", "0")] == 0 and by[("uta_rldd:11", "10")] == 1
    assert not any(r.source_label == "5" for r in res.rows)           # sem conversão silenciosa
    assert {e.source_label for e in res.excluded} == {"5"} and len(res.excluded) == 3
    assert all(e.kind == "exclude" and e.subject_id.startswith("uta_rldd:") for e in res.excluded)
    assert {r.dataset for r in res.rows} == {"uta_rldd"} and {r.dataset_version for r in res.rows} == {"teste"}
    assert res.problems == [] and res.warnings == []


def test_label_map_table_is_auditable_and_never_marks_unconfirmed_as_included():
    unconfirmed = {r["source_label"]: r for r in UTA_LABEL_MAP.table()}
    assert not any(r["included"] for r in unconfirmed.values())
    assert unconfirmed["0"]["status"] == "UNVERIFIED" and unconfirmed["5"]["status"] == "EXCLUDED"
    confirmed = {r["source_label"]: r for r in UTA_LABEL_MAP.table(UTA_OK)}
    assert confirmed["0"]["included"] and confirmed["10"]["included"] and not confirmed["5"]["included"]
    assert confirmed["0"]["safenap_label"] == 0 and confirmed["10"]["safenap_label"] == 1
    assert confirmed["5"]["safenap_label"] is None


def test_uta_collects_every_problem_instead_of_stopping_at_the_first(tmp_path):
    touch(tmp_path / "awake" / "clip001.mp4")                          # nome fora de {0,5,10}
    touch(tmp_path / "0.mp4")                                          # sem pasta de sujeito
    touch(tmp_path / "s1" / "0.mp4")
    touch(tmp_path / "s1" / "0.mov")                                   # (sujeito, classe) duplicado
    touch(tmp_path / "Fold1" / "9" / "0.mp4")
    touch(tmp_path / "Fold2" / "9" / "10.mp4")                         # mesmo nome de sujeito em pastas diferentes
    res = build_uta_manifest(tmp_path, confirm_labels=UTA_OK)
    text = "\n".join(res.problems)
    assert "não vou adivinhar" in text and "sem pasta de sujeito" in text
    assert "já tem a classe 0" in text and "pastas diferentes" in text
    assert len(res.problems) == 4


def test_uta_global_layout_failures_raise(tmp_path):
    with pytest.raises(DatasetLayoutError, match="não é um diretório"):
        build_uta_manifest(tmp_path / "nao_existe")
    empty = tmp_path / "vazio"
    empty.mkdir()
    with pytest.raises(DatasetLayoutError, match="nenhum vídeo"):
        build_uta_manifest(empty)


def test_uta_numeric_subject_ids_do_not_collide(tmp_path):
    for s in ("001", "002", "010", "100"):
        touch(tmp_path / s / "0.mp4", s.encode())
        touch(tmp_path / s / "10.mp4", (s + "x").encode())
    res = build_uta_manifest(tmp_path, confirm_labels=UTA_OK)
    ids = {r.subject_id for r in res.rows}
    assert ids == {"uta_rldd:001", "uta_rldd:002", "uta_rldd:010", "uta_rldd:100"}
    assert len({subject_key(i) for i in ids}) == 4                    # 1, 2, 10 e 100 permanecem distintos
    assert res.problems == []


def test_subject_key_flags_only_plausibly_identical_ids():
    assert subject_key("subject01") == subject_key("subject1") == subject_key("Subject-1")
    assert subject_key("01") == subject_key("1")
    assert subject_key("010") == subject_key("10") and subject_key("100") != subject_key("10")
    assert subject_key("001") != subject_key("002") != subject_key("010")


def test_same_file_name_in_different_subjects_yields_different_video_ids(tmp_path):
    """Regressão: video.stem valia '0' para TODO sujeito; clipes de pessoas diferentes colidiam."""
    for s in ("subject01", "subject02"):
        touch(tmp_path / s / "0.mp4", s.encode())
        touch(tmp_path / s / "10.mp4", (s + "x").encode())
    manifest = tmp_path / "m.csv"
    write_manifest(build_uta_manifest(tmp_path, confirm_labels=UTA_OK).rows, manifest)
    entries = read_manifest(manifest, tmp_path)
    ids = [e.video_id for e in entries]
    assert len(ids) == len(set(ids)) == 4
    assert "uta_rldd:subject01/0" in ids and "uta_rldd:subject02/0" in ids
    assert len(group_by_video(entries)) == 4                          # 4 vídeos físicos distintos


# --------------------------------------------------------------------------- NTHU-DDD

def nthu_tree(tmp_path, annotation="0011"):
    touch(tmp_path / "v" / "a.avi", b"a")
    touch(tmp_path / "ann" / "a.txt", annotation.encode())
    pairs = tmp_path / "pairs.csv"
    pairs.write_text("video,annotation,subject_id\nv/a.avi,ann/a.txt,001\n", encoding="utf-8")
    return pairs


def test_nthu_frame_labels_become_segments_with_explicit_fps():
    seg = segments_from_frame_labels("0 0 0\n1 1\n0", fps=2.0)
    assert seg == [(0.0, 1.5, "0"), (1.5, 2.5, "1"), (2.5, 3.0, "0")]
    with pytest.raises(ValueError, match="fps"):
        segments_from_frame_labels("01", fps=0)
    with pytest.raises(DatasetLayoutError, match="formato de anotação"):
        segments_from_frame_labels("0120", fps=30)                    # '2' não existe no formato assumido
    with pytest.raises(DatasetLayoutError, match="vazio"):
        segments_from_frame_labels("  \n", fps=30)


def test_nthu_segments_need_confirmed_labels_and_carry_traceability(tmp_path):
    pairs = nthu_tree(tmp_path)
    unconfirmed = build_nthu_manifest(pairs, tmp_path, fps=2.0)
    assert unconfirmed.rows == [] and {e.kind for e in unconfirmed.excluded} == {"unverified"}

    res = build_nthu_manifest(pairs, tmp_path, fps=2.0, confirm_labels=NTHU_OK, dataset_version="v-teste")
    assert [(r.start_s, r.end_s, r.label, r.source_label) for r in res.rows] == \
        [(0.0, 1.0, 0, "0"), (1.0, 2.0, 1, "1")]
    assert {(r.subject_id, r.dataset, r.dataset_version) for r in res.rows} == {("nthu_ddd:001", "nthu_ddd", "v-teste")}
    with pytest.raises(ValueError, match="fps"):
        build_nthu_manifest(pairs, tmp_path, fps=0)


def test_nthu_collects_problems_missing_files_bad_labels_duplicates_and_paths(tmp_path):
    touch(tmp_path / "v" / "ok.avi", b"1")
    touch(tmp_path / "v" / "bad.avi", b"2")
    touch(tmp_path / "v" / "dup.avi", b"3")
    touch(tmp_path / "v" / "s1.avi", b"4")
    touch(tmp_path / "v" / "s2.avi", b"5")
    touch(tmp_path / "ann" / "ok.txt", b"0101")
    touch(tmp_path / "ann" / "bad.txt", b"01x1")                      # caractere desconhecido
    touch(tmp_path / "ann" / "shared.txt", b"0011")
    pairs = tmp_path / "pairs.csv"
    pairs.write_text(
        "video,annotation,subject_id\n"
        "v/ok.avi,ann/ok.txt,1\n"
        "v/bad.avi,ann/bad.txt,2\n"
        "v/ok.avi,ann/ok.txt,1\n"                                     # vídeo duplicado
        "v/faltando.avi,ann/ok.txt,3\n"                               # vídeo ausente
        "v/dup.avi,ann/nao_existe.txt,4\n"                            # anotação ausente
        "v/s1.avi,ann/shared.txt,5\n"
        "v/s2.avi,ann/shared.txt,6\n"                                 # a mesma anotação em dois vídeos
        "../fora.avi,ann/ok.txt,7\n"                                  # fora de --raw
        "v/ok2.avi,,8\n",                                             # campo vazio
        encoding="utf-8")
    res = build_nthu_manifest(pairs, tmp_path, fps=2.0, confirm_labels=NTHU_OK)
    text = "\n".join(res.problems)
    for expected in ("já listado", "vídeo ausente", "anotação ilegível/ausente", "formato de anotação",
                     "mesma anotação", "fora de", "obrigatórios"):
        assert expected in text, expected
    assert {r.video for r in res.rows} == {"v/ok.avi", "v/s1.avi", "v/s2.avi"}   # o que era válido continua


def test_nthu_pairs_table_layout_errors_raise(tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text("video,subject_id\nv.avi,1\n", encoding="utf-8")
    with pytest.raises(DatasetLayoutError, match="sem colunas"):
        build_nthu_manifest(bad, tmp_path, fps=30)
    bad.write_text("video,annotation,subject_id\n", encoding="utf-8")
    with pytest.raises(DatasetLayoutError, match="vazia"):
        build_nthu_manifest(bad, tmp_path, fps=30)


# --------------------------------------------------------------------------- segmentos e estado temporal

def test_segment_labeled_video_is_processed_once_and_labels_follow_time(tmp_path):
    touch(tmp_path / "v" / "a.avi")
    manifest = tmp_path / "m.csv"
    manifest.write_text("video,subject_id,label,start_s,end_s\n"
                        "v/a.avi,s1,0,0,2\nv/a.avi,s1,1,2,4\n", encoding="utf-8")
    jobs = group_by_video(read_manifest(manifest, tmp_path))
    assert len(jobs) == 1                                             # uma passada: estado não reinicia na troca de rótulo
    entry, labeler = jobs[0]
    assert labeler(500) == 0 and labeler(2000) == 1 and labeler(4000) is None

    frames = [(i * 100, None) for i in range(60)]                     # 6 s a 10 fps
    rows = process_video(frames, lambda rgb, t: FACE, entry.subject_id, entry.video_id, labeler)
    assert {r["label"] for r in rows} == {0, 1}
    assert all(r["t_ms"] < 4000 for r in rows)                        # fora de segmento: sem linha
    assert all(r["video_id"] == "v/a" for r in rows)


def test_overlapping_or_mixed_subject_segments_are_rejected(tmp_path):
    touch(tmp_path / "a.avi")
    m = tmp_path / "m.csv"
    m.write_text("video,subject_id,label,start_s,end_s\na.avi,s1,0,0,3\na.avi,s1,1,2,5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="sobrepostos"):
        group_by_video(read_manifest(m, tmp_path))
    m.write_text("video,subject_id,label,start_s,end_s\na.avi,s1,0,0,2\na.avi,s2,1,2,5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="sujeitos diferentes"):
        group_by_video(read_manifest(m, tmp_path))


def test_label_at_boundaries_are_half_open():
    f = label_at([(0.0, 1.0, 0), (1.0, 2.0, 1)])
    assert (f(0), f(999), f(1000), f(1999), f(2000)) == (0, 0, 1, 1, None)
