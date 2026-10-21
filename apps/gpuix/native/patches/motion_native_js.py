# Motion-native additions to the @gpuix/native JS bridge (lane gpuix-native), executed from patch_js.py after
# render9_js.py (shares its edit table): `hoverTransition` (hover_fade.rs), `paintTransform.retain`, `scaleX`/`scaleY`.
edit('dist/mutations.js', '    "paintTransform",\n', '    "paintTransform",\n    "hoverTransition",\n')
edit('dist/host.d.ts', '    generation?: number;\n}\nexport interface HostProps {', '''    generation?: number;
    /** Keep the retained paint at rest, so an exit or reveal that starts later is paint-only from its first frame. */
    retain?: boolean;
}
export interface HoverTransition {
    /** Seconds. */
    duration?: number;
    /** cubic-bezier control points. */
    ease?: [number, number, number, number];
}
export interface HostProps {
    /** Ease `hover` / `active` background and border colour changes; inherited by descendants, `false` opts out. */
    hoverTransition?: HoverTransition | false;''')
edit('dist/host.d.ts', 'export interface PaintTransformValue {\n    scale?: number;\n', 'export interface PaintTransformValue {\n    scale?: number;\n    /** One-axis multipliers of `scale` about the origin (corners stay round at the smaller one). */\n    scaleX?: number;\n    scaleY?: number;\n    /** Multiplies only the subtree\'s drop shadows (a lift shadow fading in as a card rises). */\n    shadowOpacity?: number;\n')
edit('dist/mutations.js', '    ["onFileDragChange", "fileDragChange"],', '    ["onFileDragChange", "fileDragChange"],\n    ["onLoad", "load"],')
edit('dist/mutations.d.ts', 'readonly ["onFileDragChange", "fileDragChange"]]', 'readonly ["onFileDragChange", "fileDragChange"], readonly ["onLoad", "load"]]')
edit('dist/host.d.ts', '    hoverTransition?: HoverTransition | false;', '    hoverTransition?: HoverTransition | false;\n    /** `<img>`: its bitmap finished loading after the frame it landed in (`value`: \`loaded\` or \`failed\`). */\n    onLoad?: (event: EventPayload) => void;')
