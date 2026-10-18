# Passive work audit

The visibility boundary is a post-paint native layout observer. It does not
request a display subscription, and unchanged geometry does not notify React.
A mounted host whose painted rectangle does not intersect its clip owns no
loader-clock subscription. Native one-shot motions still finish naturally.

| Path | Visible clock / paint path | Parking |
| --- | --- | --- |
| MatrixLoader | Historical shared 200 ms React clock; native matrix explicitly opt-in | Clip observer removes shared subscription; shared clock stops with zero subscribers; AppKit visibility stops legacy clock; reduced motion is still |
| Connection spinner | Historical shared clock; opt-in existing native rotate at 1300 ms, replacing per-display JS rotate commits | Clip observer; shared legacy visibility; native window visibility handled by GPUI |
| CI / SpinIcon | Existing native rotate (stock addon long native tween fallback) | Clip observer plus AppKit visibility; reduced motion still |
| Task running glyph | Historical shared clock; opt-in native breathe | Clip observer; shared legacy visibility; reduced motion still |
| Transcript shimmer | Historical shared clock; existing native text shimmer remains opt-in | Clip observer; shared legacy visibility; reduced motion still |
| Kit Skeleton | Existing paintTransform sweep, one completion callback per crossing | Clip observer plus AppKit visibility; desktop-compatible reduced-motion sweep retained |
| Visual skeleton | Historical shared clock | Clip observer; shared legacy visibility; reduced motion still |
| Subagent / working elapsed labels | Shared aligned one-second informational timeout | Clip observer plus AppKit visibility; advances under reduced motion |
| Streaming caret | Existing discrete 500 ms JS blink; new-word fade is native Markdown paint | Clip observer and window changes clear/restart the timer; reduced motion still |
| Terminal focused caret | Existing 500 ms timer with focus/motion gating and hidden-window callback guard | Remaining gap: hidden window suppresses mutations but retains its timer; no terminal change in this lane |
| Platform-state / occlusion | Existing platform 400 ms visibility poll / window-state refresh | Remaining platform polling, no scene submission unless state changes |
| Composer slow status text | Existing 15-second informational update | Existing window visibility subscription |
| Preview recents/discovery/retry, device/login/provider limits polls | Existing data refresh, not continuous animation | Existing component/pane lifetime; no cadence change here |
| Pop, check-draw, stroke, entrance/exit tweens | Finite native paint motions | One-shot, no perpetual clock |
| Drag edge scroll | Demand-based onFrame subscription | Active drag lifetime; not passive |
| Paced streaming | Demand-based pending events / reveal catch-up | Existing bounded stream lifetime; not passive |

Native loop defaults remain off unless the historical GPU resource gate can be
shown to pass. Enabling display-rate replay where a 5 Hz stepped appearance was
approved changes both workload and appearance; the on/off resource controls are
reported as a decision test, not as a matched product optimization.

Reference review: zeron c02739da309118c2174f427511110046f0bfba16,
`crates/ui/src/motion.rs` hover_listener/hover_fades_active refreshes on input
and requests subsequent frames only while a fade is active. Zed GPUI
56934ec0560bce8929025497411de7f5322fb6ca,
`crates/gpui/src/elements/animation.rs` requests the next animation frame only
while the spring is unfinished; its platform contract describes AppKit
occlusion. This lane uses the same demand-based lifetime principle without
changing the renderer or adding a polling animation clock.

Inactive dock panels are conditional children in `src/dock/Dock.tsx`, so their
loops unmount on a tab switch. Window hiding is distinct from retained clipping: legacy clocks use the existing AppKit visibility subscription, and native
plans use GPUI window visibility. The observer itself checks painted geometry;
it does not infer visibility from arbitrary ancestor opacity.
