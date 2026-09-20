"""Gera e VALIDA o manifesto de extração a partir da estrutura de um dataset real (UTA-RLDD ou NTHU-DDD).

Etapa 1 do pipeline: dataset -> manifest -> validação -> dataset_summary.json. NÃO extrai features e NÃO
treina; isso são etapas separadas (extract_features.py, train_model.py), só depois de você revisar o resumo.

Uso:
    # 1) ver o layout SEM escrever nada (rápido, sem processamento pesado):
    python scripts/build_manifest.py uta  --raw ../data/raw/uta --dry-run [--probe]
    python scripts/build_manifest.py nthu --raw ../data/raw/nthu --pairs pares.csv --fps 30 --dry-run
    # 2) depois de conferir a documentação oficial dos rótulos, gerar de verdade:
    python scripts/build_manifest.py uta --raw ../data/raw/uta --out ../data/manifests/uta.csv \\
        --confirm-labels uta_rldd/v1 --dataset-version "<versão baixada>"

Mapeamentos de rótulo nascem UNVERIFIED: sem `--confirm-labels <id>` nenhuma classe incluída entra no
manifesto. O dry-run SIMULA a confirmação só para checar o layout e diz isso explicitamente.
Saída: exit code 0 = ok, 1 = problemas críticos (nenhum arquivo é escrito).
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dataset_adapters.common import DEFAULT_VERSION, DatasetLayoutError, write_manifest  # noqa: E402
from dataset_adapters.nthu_ddd import NTHU_LABEL_MAP, build_nthu_manifest  # noqa: E402
from dataset_adapters.uta_rldd import UTA_LABEL_MAP, build_uta_manifest  # noqa: E402
from dataset_adapters.validation import format_report, validate_rows  # noqa: E402


def _print_label_table(label_map, confirmed: Optional[str], effective: Optional[str]) -> None:
    """`confirmed` = confirmação REAL do usuário; `effective` = a usada no cálculo (o dry-run simula)."""
    note = "" if confirmed == effective else " - SIMULADO só para checar o layout (dry-run)"
    print(f"Mapa de rótulos {label_map.id}  (confirmado pelo usuário: {'SIM' if confirmed == label_map.id else 'NAO'}{note})")
    print("  original | SafeNap | incluído | status     | motivo")
    for r in label_map.table(effective):
        print(f"  {r['source_label']:>8} | {str(r['safenap_label']):>7} | {str(r['included']):>8} | "
              f"{r['status']:<10} | {r['reason']}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Monta e valida o manifesto de um dataset de sonolência")
    p.add_argument("dataset", choices=["uta", "nthu"])
    p.add_argument("--raw", type=Path, required=True)
    p.add_argument("--out", type=Path, help="manifesto de saída (obrigatório sem --dry-run)")
    p.add_argument("--pairs", type=Path, help="nthu: CSV video,annotation,subject_id")
    p.add_argument("--fps", type=float, help="nthu: frames por segundo dos vídeos (sem padrão)")
    p.add_argument("--confirm-labels", help="id do mapa de rótulos, ex. uta_rldd/v1 (só após conferir a documentação)")
    p.add_argument("--dataset-version", default=DEFAULT_VERSION, help="versão/fonte do download, para rastreio")
    p.add_argument("--dry-run", action="store_true", help="valida e mostra o resumo sem escrever nada")
    p.add_argument("--probe", action="store_true", help="abre cada vídeo (OpenCV) para contar frames/fps")
    p.add_argument("--summary-out", type=Path, help="dataset_summary.json (padrão: ao lado do manifesto)")
    a = p.parse_args(argv)

    label_map = UTA_LABEL_MAP if a.dataset == "uta" else NTHU_LABEL_MAP
    effective = a.confirm_labels or (label_map.id if a.dry_run else None)
    if a.confirm_labels and a.confirm_labels != label_map.id:
        print(f"ERRO: --confirm-labels {a.confirm_labels!r} não é o id do mapa atual {label_map.id!r} "
              f"(o mapa mudou? reconfira a documentação)")
        return 1
    if a.dry_run and not a.confirm_labels:
        print("AVISO: mapeamento de rótulos NÃO confirmado. O dry-run simula a confirmação só para checar o "
              "layout; o build real exige --confirm-labels.")

    try:
        if a.dataset == "uta":
            result = build_uta_manifest(a.raw, effective, a.dataset_version)
        else:
            if not a.pairs or not a.fps:
                p.error("nthu exige --pairs e --fps")
            result = build_nthu_manifest(a.pairs, a.raw, a.fps, effective, a.dataset_version)
    except (DatasetLayoutError, ValueError, OSError) as exc:
        print(f"ERRO: {exc}")
        return 1

    _print_label_table(label_map, a.confirm_labels, effective)
    report = validate_rows(result.rows, a.raw, excluded=result.excluded, problems=result.problems,
                           warnings=result.warnings, probe=a.probe)
    print(format_report(report))
    if not report.ok:
        print("Nenhum arquivo escrito: corrija os problemas acima (o pipeline não adivinha layouts).")
        return 1
    if a.dry_run:
        print("[dry-run] nada foi escrito.")
        return 0
    if not a.out:
        p.error("--out é obrigatório sem --dry-run")

    write_manifest(result.rows, a.out)
    summary_path = a.summary_out or a.out.parent / "dataset_summary.json"
    summary_path.write_text(json.dumps({"label_map": label_map.table(effective), "label_map_id": label_map.id,
                                        "manifest": a.out.name, **report.summary}, indent=2, ensure_ascii=False),
                            encoding="utf-8")
    print(f"[ok] manifesto -> {a.out}\n[ok] resumo    -> {summary_path}")
    print("Revise o manifesto e o resumo; só então rode extract_features.py (etapa separada).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
