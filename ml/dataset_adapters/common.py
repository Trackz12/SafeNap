"""Tipos e utilidades comuns aos adaptadores de dataset (manifesto de extração).

Um adaptador converte a estrutura de UM dataset público no manifesto lido por
`scripts/extract_features.py`:

    dataset,dataset_version,video,subject_id,label,source_label,start_s,end_s

Regras (acadêmicas, não estilísticas):
  - O rótulo do dataset NUNCA é convertido em silêncio. Cada classe original tem uma `LabelRule`:
    incluída (0/1) ou EXCLUÍDA, e todo mapeamento de inclusão nasce `UNVERIFIED`: só entra no manifesto
    quando o usuário, depois de ler a documentação oficial, confirma o id do mapa (`--confirm-labels`).
  - Estrutura inesperada NÃO é adivinhada nem "consertada": vira `problems` (coletados, para o dry-run
    listar todos de uma vez) e o build falha.
  - `source_label` preserva o rótulo original; toda exclusão é registrada com motivo, sujeito e vídeo.
  - Testes com árvores sintéticas validam o COMPORTAMENTO do adaptador, não a correspondência dele com o
    dataset oficial (essa só se verifica com os arquivos reais).
"""

import csv
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

LABEL_ALERT = 0
LABEL_DROWSY = 1
DEFAULT_DATASET = "unspecified"
DEFAULT_VERSION = "UNVERIFIED"
MANIFEST_COLUMNS = ["dataset", "dataset_version", "video", "subject_id", "label", "source_label",
                    "start_s", "end_s"]

UNVERIFIED = "UNVERIFIED"            # mapeamento sem confirmação: não entra sem --confirm-labels
EXCLUDED_BY_DESIGN = "EXCLUDED"      # exclusão deliberada (sem equivalência binária defensável)


class DatasetLayoutError(ValueError):
    """A estrutura encontrada não bate com a que o adaptador documenta (falha global)."""


@dataclass(frozen=True)
class LabelRule:
    source: str                      # rótulo original do dataset
    safenap: Optional[int]           # 0 alerta | 1 sonolento | None = excluído
    status: str                      # UNVERIFIED | EXCLUDED_BY_DESIGN
    reason: str


@dataclass(frozen=True)
class Resolution:
    kind: str                        # include | exclude | unverified | unknown
    label: Optional[int]
    reason: str


@dataclass(frozen=True)
class LabelMap:
    id: str                          # ex. "uta_rldd/v1"; mudar o mapa exige novo id => nova confirmação
    dataset: str
    rules: Tuple[LabelRule, ...]

    def sources(self) -> Tuple[str, ...]:
        return tuple(r.source for r in self.rules)

    def resolve(self, source: str, confirmed: Optional[str]) -> Resolution:
        rule = next((r for r in self.rules if r.source == source), None)
        if rule is None:
            return Resolution("unknown", None, f"rótulo original {source!r} desconhecido para {self.id}")
        if rule.status == EXCLUDED_BY_DESIGN:
            return Resolution("exclude", None, rule.reason)
        if confirmed != self.id:
            return Resolution("unverified", None,
                              f"{UNVERIFIED}: mapa {self.id} não confirmado (use --confirm-labels {self.id} "
                              f"após conferir a documentação oficial)")
        return Resolution("include", rule.safenap, rule.reason)

    def table(self, confirmed: Optional[str] = None) -> List[dict]:
        """Tabela auditável: rótulo original -> rótulo SafeNap, incluído?, motivo, status."""
        out = []
        for r in self.rules:
            res = self.resolve(r.source, confirmed)
            out.append({"source_label": r.source, "safenap_label": r.safenap, "status": r.status,
                        "included": res.kind == "include", "reason": r.reason})
        return out


@dataclass(frozen=True)
class ManifestRow:
    video: str                      # relativo a --raw, com "/" (POSIX)
    subject_id: str                 # já com namespace do dataset ("uta_rldd:11")
    label: int                      # 0 alerta | 1 sonolento
    source_label: str               # rótulo original do dataset
    start_s: Optional[float] = None
    end_s: Optional[float] = None
    dataset: str = DEFAULT_DATASET
    dataset_version: str = DEFAULT_VERSION


@dataclass(frozen=True)
class Excluded:
    video: str
    source_label: str
    reason: str
    subject_id: str = ""
    dataset: str = DEFAULT_DATASET
    kind: str = "exclude"           # exclude (por desenho) | unverified (mapa não confirmado)


@dataclass
class BuildResult:
    rows: List[ManifestRow] = field(default_factory=list)
    excluded: List[Excluded] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)      # críticos: build/extração falham
    warnings: List[str] = field(default_factory=list)


def write_manifest(rows: Sequence[ManifestRow], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(MANIFEST_COLUMNS)
        for r in rows:
            w.writerow([r.dataset, r.dataset_version, r.video, r.subject_id, r.label, r.source_label,
                        "" if r.start_s is None else r.start_s, "" if r.end_s is None else r.end_s])


def read_manifest_rows(path: Path) -> Tuple[List[ManifestRow], List[str]]:
    """Lê o manifesto SEM levantar no primeiro erro: devolve (linhas válidas, problemas).
    Colunas dataset/dataset_version/source_label são opcionais (manifesto escrito à mão)."""
    rows: List[ManifestRow] = []
    problems: List[str] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = [c for c in ("video", "subject_id", "label") if c not in (reader.fieldnames or [])]
        if missing:
            return [], [f"manifesto sem colunas obrigatórias: {missing}"]
        for n, row in enumerate(reader, start=2):
            label = (row.get("label") or "").strip()
            if label not in ("0", "1"):
                problems.append(f"manifesto linha {n}: label deve ser 0 ou 1, veio {label!r}")
                continue
            times: List[Optional[float]] = []
            bad_time = False
            for col in ("start_s", "end_s"):
                raw = (row.get(col) or "").strip()
                try:
                    v = float(raw) if raw else None
                except ValueError:
                    v = math.nan
                if v is not None and not math.isfinite(v):
                    problems.append(f"manifesto linha {n}: {col} inválido ({raw!r})")
                    bad_time = True
                times.append(v)
            if bad_time:
                continue
            rows.append(ManifestRow(
                video=(row.get("video") or "").strip(), subject_id=(row.get("subject_id") or "").strip(),
                label=int(label), source_label=(row.get("source_label") or "").strip(),
                start_s=times[0], end_s=times[1],
                dataset=(row.get("dataset") or "").strip() or DEFAULT_DATASET,
                dataset_version=(row.get("dataset_version") or "").strip() or DEFAULT_VERSION))
    return rows, problems


def relative_posix(path: Path, root: Path) -> str:
    """Caminho relativo a `root` com '/'; recusa caminhos fora de `root`."""
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as exc:
        raise DatasetLayoutError(f"{path} está fora de {root}") from exc
