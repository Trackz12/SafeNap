"""Baixa datasets públicos de detecção de sonolência e extrai features.

Datasets suportados:
- UTA-RLDD (University of Texas at Arlington Real-Life Drowsiness Dataset)
- NTHU Drowsiness Detection Dataset (requer aprovação via formulário)

Uso:
    python scripts/download_datasets.py --dataset uta --out ../data/raw/uta
    python scripts/download_datasets.py --dataset nthu --out ../data/raw/nthu

Nota: o NTHU requer aprovação acadêmica (formulário de acesso). O download
automático só funciona para o UTA-RLDD, que é publicamente acessível via
Google Drive (pasta pública). Para o NTHU, coloque os vídeos manualmente em
../data/raw/nthu/ seguindo a estrutura: Video/ e Evaluation/
"""

import argparse
import os
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.stderr.write("pip install requests tqdm primeiro\n")
    sys.exit(1)

try:
    from tqdm import tqdm
except ImportError:
    def tqdm(iterable, **kwargs):  # type: ignore
        return iterable


UTA_RLDD_DOWNLOADS = {
    # Pasta pública do dataset UTA-RLDD (Google Drive — arquivos zipados por classe)
    "awake": "https://drive.google.com/uc?export=download&id=FILL_ME_AWAKE",
    "low": "https://drive.google.com/uc?export=download&id=FILL_ME_LOW",
    "high": "https://drive.google.com/uc?export=download&id=FILL_ME_HIGH",
}


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        print(f"[skip] {dest.name} já existe")
        return
    print(f"[download] {dest.name} ...")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with open(dest, "wb") as f:
            with tqdm(total=total, unit="B", unit_scale=True) as pbar:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
                    pbar.update(len(chunk))


def prepare_uta(out: Path) -> None:
    """Baixa e prepara o UTA-RLDD.

    Nota: os IDs de arquivo do Google Drive precisam ser preenchidos manualmente
    (o dataset é distribuído por formulário). Coloque os vídeos em:
      out/awake/, out/low/, out/high/
    """
    out.mkdir(parents=True, exist_ok=True)
    for label, url in UTA_RLDD_DOWNLOADS.items():
        if "FILL_ME" in url:
            print(f"[manual] classe '{label}': adicione os vídeos em {out / label}/")
            continue
        download_file(url, out / f"{label}.zip")


def prepare_nthu(out: Path) -> None:
    """Prepara o NTHU (requer download manual após aprovação).

    Estrutura esperada:
      out/Video/  → vídeos .avi (subject11_drowsy.avi, etc.)
      out/Evaluation/ → arquivos .txt com labels de olhos
    """
    out.mkdir(parents=True, exist_ok=True)
    print(f"[manual] NTHU requer aprovação. Coloque vídeos em {out / 'Video'}/")
    print(f"[manual] e labels em {out / 'Evaluation'}/")


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepara datasets de sonolência")
    parser.add_argument("--dataset", choices=["uta", "nthu"], required=True)
    parser.add_argument("--out", type=Path, default=Path("../data/raw"))
    args = parser.parse_args()

    out = args.out.resolve()
    if args.dataset == "uta":
        prepare_uta(out)
    else:
        prepare_nthu(out)

    print(f"\n[ok] preparado em {out}")


if __name__ == "__main__":
    main()
