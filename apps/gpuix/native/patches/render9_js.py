# render9 additions to the @gpuix/native JS bridge, executed from patch_js.py (shares its edit table).
# `paintTransform` (subtree_transform.rs) and `onFileDragChange` (file_drag.rs).
edit('dist/mutations.js', '    "paintTranslate",', '    "paintTranslate",\n    "paintTransform",')
edit('dist/mutations.js', '    ["onFileDrop", "fileDrop"],', '    ["onFileDrop", "fileDrop"],\n    ["onFileDragChange", "fileDragChange"],')
edit('dist/mutations.d.ts', 'readonly ["onFileDrop", "fileDrop"]]', 'readonly ["onFileDrop", "fileDrop"], readonly ["onFileDragChange", "fileDragChange"]]')
edit('dist/host.d.ts', 'export interface HostProps {', '''export interface PaintTransformValue {
    scale?: number;
    /** Clockwise degrees. */
    rotate?: number;
    translateX?: number;
    translateY?: number;
    opacity?: number;
    /** `filter: blur()` radius in logical pixels. */
    blur?: number;
}
export interface PaintTransformTiming {
    /** Seconds. */
    duration?: number;
    delay?: number;
    /** cubic-bezier control points; y may leave [0, 1]. */
    ease?: [number, number, number, number];
}
export interface PaintTransformProps {
    initial?: false | PaintTransformValue;
    animate?: PaintTransformValue;
    transition?: PaintTransformTiming;
    /** CSS-style intermediate stops between the start and `animate`. */
    keyframes?: Array<PaintTransformValue & { offset: number }>;
    /** Fractions of the element's box; defaults to the centre. */
    origin?: [number, number];
    /** Native `:active` squash on primary mouse down. */
    press?: { scale: number; down?: PaintTransformTiming; up?: PaintTransformTiming };
    generation?: number;
}
export interface HostProps {
    /** Paint-only subtree scale / rotation / opacity / blur; layout never moves. */
    paintTransform?: PaintTransformProps;
    /** A Finder drag entered (`hovered: true`) or left (`hovered: false`) this element. */
    onFileDragChange?: (event: EventPayload) => void;''')
