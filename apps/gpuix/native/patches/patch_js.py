"""Add `cache` to @gpuix/native's forwarded universal props (a pnpm patch dir).

React only forwards allow-listed props on built-in elements; without this the
`cache` prop never reaches the native tree.

    python3 patch_js.py <pnpm patch edit dir>
"""
import sys
from pathlib import Path

path = Path(sys.argv[1]) / "dist" / "mutations.js"
text = path.read_text()
anchor = '    "motion",\n    "testId",'
if text.count(anchor) != 1:
    raise SystemExit(f"{path}: UNIVERSAL_PROPS anchor not found; update patch_js.py")
path.write_text(text.replace(anchor, '    "motion",\n    // Kybern patch: cached islands (apps/gpuix/native/patches).\n    "cache",\n    "testId",'))
print("JS patch applied")
