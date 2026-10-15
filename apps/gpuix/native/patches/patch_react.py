"""Keep native motion generations in sync with Kybern's additional properties."""
import sys
from pathlib import Path
root = Path(sys.argv[1])
pending = {}
def edit(name, old, new):
    text = pending.get(name, (root / name).read_text())
    if text.count(old) != 1:
        raise SystemExit(f"{name}: moved anchor; nothing written: {old}")
    pending[name] = text.replace(old, new)
edit('dist/components/index.js', '        style.borderRadius,', '        style.borderRadius,\n        style.translateX,\n        style.translateY,')
edit('dist/components/index.js', '        transition?.ease,', '        transition?.ease,\n        transition?.type,\n        transition?.bounce,\n        transition?.velocityX,\n        transition?.velocityY,')
edit('dist/components/index.d.ts', 'export interface MotionDivProps extends MotionProps {', 'export interface MotionDivProps extends MotionProps {\n    windowDrag?: boolean;\n    cache?: boolean | "fill";\n    testId?: string;')
for name, text in pending.items():
    (root / name).write_text(text)
print(f"React patch applied to {len(pending)} files")
