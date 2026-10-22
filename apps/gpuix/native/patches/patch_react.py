"""Keep native motion generations in sync with Kybern's additional properties."""
import sys
from pathlib import Path
import hook_check
root = Path(sys.argv[1])
pending = {}
def edit(name, old, new):
    text = pending.get(name, (root / name).read_text())
    if text.count(old) != 1:
        hook_check.missing(f"{name}: expected 1 anchor(s), found {text.count(old)}; nothing written:\n{old}")
        pending[name] = text
        return
    pending[name] = text.replace(old, new)


def run_hook(file):
    hook_check.run(file, Path(__file__).parent, globals())
edit('dist/components/index.js', '        style.borderRadius,', '        style.borderRadius,\n        style.translateX,\n        style.translateY,')
edit('dist/components/index.js', '        style.borderRadius,', '        style.borderRadius,\n        style.rotate,')
edit('dist/components/index.js', '        transition?.ease,', '        transition?.ease,\n        transition?.type,\n        transition?.bounce,\n        transition?.velocityX,\n        transition?.velocityY,')
edit('dist/components/index.js', '        transition?.ease,', '        transition?.ease,\n        transition?.stiffness,\n        transition?.damping,\n        transition?.mass,')
edit('dist/components/index.d.ts', 'export interface MotionDivProps extends MotionProps {', 'export interface MotionDivProps extends MotionProps {\n    windowDrag?: boolean;\n    cache?: boolean | "fill";\n    testId?: string;')
# 0.11 dims every other focusable at 40% while a control has keyboard focus. The
# app draws its own focus look, so the default is off here; a root opts in with
# `keyboardFocusDim: true`.
edit('dist/reconciler/reconciler.js', 'setKeyboardFocusDim(rootEventHandlers.keyboardFocusDim !== false)', 'setKeyboardFocusDim(rootEventHandlers.keyboardFocusDim === true)')
runtime=pending['dist/components/index.js']
start=runtime.index('const MotionDiv = forwardRef(')
end=runtime.index('/** Native animations',start)
svg=runtime[start:end].replace('MotionDiv','MotionSvg').replace('createElement("div", hostProps)','createElement("svg", hostProps)')
edit('dist/components/index.js','/** Native animations',svg+'/** Native animations')
edit('dist/components/index.js','    div: MotionDiv,','    div: MotionDiv,\n    svg: MotionSvg,')
edit('dist/components/index.d.ts','export declare const motion: {','export declare const motion: {\n    readonly svg: import("react").ForwardRefExoticComponent<MotionDivProps & { source?: string; src?: string } & import("react").RefAttributes<import("../types/host.js").Instance>>;')
for name, text in pending.items():
    if not hook_check.CHECK or not hook_check.problems:
        (root / name).write_text(text)
hook_check.finish(f"React patch applied to {len(pending)} files")
