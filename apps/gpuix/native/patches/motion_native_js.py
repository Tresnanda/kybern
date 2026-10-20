# Motion-native additions to the @gpuix/native JS bridge (lane gpuix-native), executed from patch_js.py after
# render9_js.py (shares its edit table): `hoverTransition` (hover_fade.rs) and `paintTransform.retain`.
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
