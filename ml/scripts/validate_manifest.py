"""Valida um manifesto (gerado por build_manifest.py OU escrito/editado à mão) antes da extração.

    python scripts/validate_manifest.py --manifest ../data/manifests/uta.csv --raw ../data/raw/uta [--probe]
        [--summary-out ../data/manifests/dataset_summary.json]

Confere existência/tamanho dos arquivos, ids, duplicatas, sobreposição de segmentos, mistura de sujeitos,
identidade duvidosa, arquivos idênticos e suficiência de sujeitos por classe. Com --probe abre cada vídeo
(OpenCV) e checa frames/fps e duração x anotação. Exit code 0 = ok, 1 = erros. Não escreve nada além do
resumo opcional. (Exclusões de rótulo só existem no resumo do build_manifest; aqui excluded_samples = 0.)
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dataset_adapters.common import read_manifest_rows  # noqa: E402
from dataset_adapters.validation import format_report, validate_rows  # noqa: E402


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Valida um manifesto de extração")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--raw", type=Path, required=True)
    p.add_argument("--probe", action="store_true")
    p.add_argument("--summary-out", type=Path)
    a = p.parse_args(argv)

    rows, problems = read_manifest_rows(a.manifest)
    report = validate_rows(rows, a.raw, problems=problems, probe=a.probe)
    print(format_report(report))
    if report.ok and a.summary_out:
        a.summary_out.write_text(json.dumps({"manifest": a.manifest.name, **report.summary}, indent=2,
                                            ensure_ascii=False), encoding="utf-8")
        print(f"[ok] resumo -> {a.summary_out}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
