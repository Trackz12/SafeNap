import json
import re
from pathlib import Path

from features.schema import FEATURE_ORDER, NULL_BLINK_SENTINEL, NUM_FEATURES, SCHEMA_PATH

ROOT = Path(__file__).resolve().parents[2]
FROZEN = [
    'ear', 'earL', 'earR', 'mouthAspect', 'noseDropRatio', 'yawRatio',
    'earMean', 'earStdDev', 'earMin', 'earMax', 'earTrendPerSec',
    'blinkRate', 'msSinceLastBlink', 'perclos',
    'mouthMean', 'mouthMax', 'mouthTrendPerSec', 'noseDropMean',
]


def test_python_order_is_the_shared_json_and_is_frozen():
    raw = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert FEATURE_ORDER == raw["features"] == FROZEN
    assert NUM_FEATURES == 18 and len(set(FEATURE_ORDER)) == 18
    assert NULL_BLINK_SENTINEL == raw["nullBlinkSentinel"] == -1


def test_typescript_feature_order_matches_python_by_position():
    """Lê frontend/src/ml/featureOrder.ts como texto: não basta ter os mesmos nomes, a POSIÇÃO tem de bater."""
    ts = (ROOT / "frontend" / "src" / "ml" / "featureOrder.ts").read_text(encoding="utf-8")
    block = re.search(r"FEATURE_ORDER\s*=\s*\[(.*?)\]\s*as const", ts, re.S).group(1)
    assert re.findall(r"'([A-Za-z]+)'", block) == FEATURE_ORDER
    assert int(re.search(r"NULL_BLINK_SENTINEL\s*=\s*(-?\d+)", ts).group(1)) == NULL_BLINK_SENTINEL
