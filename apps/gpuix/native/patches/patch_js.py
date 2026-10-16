"""Patch @gpuix/native's JS bridge and declarations atomically."""
import sys
from pathlib import Path
root = Path(sys.argv[1])
pending = {}
def edit(name, old, new):
    text = pending.get(name, (root / name).read_text())
    if text.count(old) != 1:
        raise SystemExit(f"{name}: moved anchor; nothing written: {old}")
    pending[name] = text.replace(old, new)

edit('dist/mutations.js', '    "motion",\n    "testId",', '    "motion",\n    // Kybern native capabilities.\n    "backdrop",\n    "paintAnimation",\n    "cache",\n    "windowDrag",\n    "interceptKeys",\n    "secure",\n    "softWrap",\n    "testId",')
edit('dist/host.d.ts', 'export interface HostProps {', 'export interface HostProps {\n    cache?: boolean | "fill";\n    /** Empty titlebar region; do not place on interactive controls. */\n    windowDrag?: boolean;')
edit('dist/host.d.ts', 'export interface InputProps extends HostProps {', 'export interface InputProps extends HostProps {\n    /** Key names delivered before native editing actions, with preventDefault(). */\n    interceptKeys?: string[];\n    /** Password input: masked paint/accessibility, no copy or cut. */\n    secure?: boolean;')
edit('index.d.ts', 'export declare class GpuixRenderer {', 'export declare class GpuixRenderer {\n  resolveKeyEvent(token: number, prevented: boolean): void\n  setCloseGuard(enabled: boolean): void\n  resolveCloseRequest(token: number, allow: boolean): void')
edit('dist/host.d.ts', '    onKeyDown?: (event: EventPayload) => void;', '    onKeyDown?: (event: EventPayload & { preventDefault(): void; defaultPrevented: boolean }) => void;')
edit('dist/renderer-state.js', '        dispatch(event) {\n            const root = active;', """        dispatch(event) {
            if (event.eventType === "shouldClose") {
                Promise.resolve().then(() => state.shouldClose?.() ?? true)
                    .then(allow => renderer.resolveCloseRequest(event.requestId, allow === true))
                    .catch(error => { renderer.resolveCloseRequest(event.requestId, false); console.error(error); });
                return true;
            }
            if (event.eventType === "keyDown") {
                event.defaultPrevented = false;
                event.preventDefault = () => { event.defaultPrevented = true; };
                if (event.requestId != null) {
                    const handler = active?.eventHandlers.get(event.elementId)?.get("keyDown");
                    try { handler?.(event); active?.handlers.onEvent?.(event); }
                    catch (error) { event.preventDefault(); throw error; }
                    finally { renderer.resolveKeyEvent(event.requestId, event.defaultPrevented); }
                    return !!handler;
                }
            }
            const root = active;""")
edit('dist/renderer-state.js', 'const STATE_KEY =', """/** Install a close guard. Rejections veto; repeated close attempts coalesce. */
export function setWindowCloseHandler(renderer, handler) {
    const state = createRendererState(renderer);
    state.shouldClose = handler;
    renderer.setCloseGuard(!!handler);
    return () => {
        if (state.shouldClose === handler) {
            state.shouldClose = undefined;
            renderer.setCloseGuard(false);
        }
    };
}
const STATE_KEY =""")
edit('dist/renderer-state.d.ts', 'import type { EventPayload }', 'export declare function setWindowCloseHandler(renderer: NativeRenderer, handler: () => boolean | Promise<boolean>): () => void;\nimport type { EventPayload }')

edit('dist/host.d.ts', '"setWindowKeyEvents" |', '"resolveKeyEvent" | "setCloseGuard" | "resolveCloseRequest" | "setWindowKeyEvents" |')
edit('dist/host.d.ts', 'export interface CodeProps extends HostProps {', 'export interface CodeProps extends HostProps {\n    /** Wrap highlighted lines at the available width. */\n    softWrap?: boolean;')
edit('dist/host.d.ts', 'export interface MotionStyle {', 'export interface MotionStyle {\n    translateX?: number;\n    translateY?: number;')
edit('dist/host.d.ts', 'export interface MotionTransition {', 'export interface MotionTransition {\n    type?: "tween" | "spring";\n    /** Damping control from 0 (no overshoot) to 1. */\n    bounce?: number;\n    /** Translation velocity in logical pixels per second. */\n    velocityX?: number;\n    velocityY?: number;')
edit('dist/automation/client.js', '        scrollWheel: (params) => {', """        fileDrop: (params) => {
            this.renderer.nativeSimulateFileDrop(params.x, params.y, params.paths);
            return { ok: true };
        },
        scrollWheel: (params) => {""")
edit('dist/automation/client.js', '        nativeSimulateScrollWheel(x, y, deltaX, deltaY, modifiers) {', """        nativeSimulateFileDrop(x, y, paths) {
            renderer.simulateFileDrop(x, y, paths);
            afterInput();
        },
        nativeSimulateScrollWheel(x, y, deltaX, deltaY, modifiers) {""")

edit('dist/runtime.js', '        stopped = true;', '        stopped = true;\n        renderer.setFrameWakeCallback?.(null);')
edit('dist/runtime.js', '    loop();\n    return { stop };', '    if (typeof renderer.setFrameWakeCallback === "function" && process.env.KYBERN_VSYNC_WAKE === "1") {\n        renderer.setFrameWakeCallback((error) => {\n            if (stopped) return;\n            try {\n                if (error) options.onError?.(error);\n                else if (renderer.tick() === false) { stop(); options.onTerminated?.(); }\n            } catch (error) { options.onError?.(error); }\n            finally { renderer.acknowledgeFrameWake(); }\n        });\n    }\n    loop();\n    return { stop };')
edit('dist/automation/protocol.js', '    scrollWheel: {', '    fileDrop: {\n        params: pointSchema.extend({ paths: z.array(z.string()).min(1) }),\n        result: okSchema,\n    },\n    scrollWheel: {')
edit('dist/automation/protocol.d.ts', '    readonly scrollWheel: {', '    readonly fileDrop: {\n        readonly params: z.ZodObject<{ x: z.ZodNumber; y: z.ZodNumber; paths: z.ZodArray<z.ZodString> }, z.core.$strip>;\n        readonly result: z.ZodObject<{ ok: z.ZodLiteral<true> }, z.core.$strip>;\n    };\n    readonly scrollWheel: {')
for name, text in pending.items():
    (root / name).write_text(text)
print(f"JS patch applied to {len(pending)} files")
