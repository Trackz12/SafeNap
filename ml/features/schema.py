"""Schema das 18 features — lido de shared/feature_schema.json (fonte única de verdade).

O frontend (frontend/src/ml/featureOrder.ts) espelha este mesmo arquivo e há
testes de paridade nos dois lados. Não redefina a ordem aqui.
"""

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "feature_schema.json"

_RAW: Dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

FEATURE_ORDER: List[str] = list(_RAW["features"])
NUM_FEATURES: int = len(FEATURE_ORDER)
NULL_BLINK_SENTINEL: int = int(_RAW["nullBlinkSentinel"])

WINDOW: Dict[str, Any] = dict(_RAW["window"])
LANDMARKS: Dict[str, Any] = dict(_RAW["landmarks"])
SCHEMA_VERSION: int = int(_RAW["version"])

# Hash do vetor ordenado: entra no model card para amarrar um ONNX à ordem exata
# das features com que foi treinado.
SCHEMA_HASH: str = hashlib.sha256(",".join(FEATURE_ORDER).encode("utf-8")).hexdigest()[:16]
