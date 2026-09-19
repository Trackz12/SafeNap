import sys
from pathlib import Path

ML = Path(__file__).resolve().parent.parent
for p in (ML, ML / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
