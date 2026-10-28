# Composer panel stacking — 2026-09-12

Activity and queued follow-ups each supplied their own inset frame, top rounding,
blur layer, and negative bottom margin. Question forms added rounded bottom edges
and spacing; permission cards used a wider surface. Together they produced
rounded interior seams, mismatched widths, and overlapping edges during the
independent translate/scale entrances. The screenshot was reproduced with the
real `ThreadView` and a synthetic background task plus an attached queued prompt.

`ComposerPanelStack` now owns the shared outline, inset width, rounding, and one
glass layer. Activity, queue, async questions, blocking input, command/plan
approvals, and connector consent render as sections with continuous hairlines.
The stack closes its bottom edge when a blocking form replaces the input.
Sections fade in without translating their shared edges. Existing question,
queue, and approval interactions and the approval attention indicator remain.

The floating composer is bounded by its thread pane. Excess combined panels
scroll while the composer stays reachable; question bodies and queued lists keep
their existing inner scroll limits. Very short panes may require scrolling the
outer stack to reach a form's actions. Long approval text can wrap in narrow
panes. No dependencies, streaming schedules, or transcript row logic changed in
this follow-up.

## Native verification

Apple M1, macOS 27.0, system WKWebView, production Vite bundles under Kybern's
production CSP at `tauri://localhost`. The baseline reproduces the mismatched
seams in the original 36 theme/width/request combinations. The expanded fixture
passes 60 layout cases, plus additional material, focus, and animation checks:

- Light/dark, 320/480/1000 CSS-pixel pane widths (capped by the native window),
  360/520/720-pixel pane heights, standalone and combined panels.
- Async/blocking questions, command approvals, long implementation plans, and
  real connector-consent metadata; 0/1/12 queued prompts, nine attached context
  items per prompt, and eight-question forms.
- Shared edges, no horizontal overflow, bounded stack height, reachable final
  actions, and a closed bottom border when the input is hidden.
- Retained queued edit text and focus during question arrival and task completion.
- Increased UI text, RTL, opaque/translucent themes, and CSSOM-emulated reduced
  transparency, increased contrast, and reduced motion without changing macOS
  preferences. Entrances are paused at five progress points and replaced during
  entry to verify stable seams.

Native `questions`, `prompts`, `work-shell`, and `interaction` fixtures pass.
These preserve explicit submission, multiline/secret answers, busy/error/retry
states, attachment-preserving queue edits, selection/focus, navigation, reading
position, and wheel/keyboard/scrollbar/touch follow resumption. The production
window-material check also passes. Queue/question and narrow approval screenshots
were visually reviewed.

In the existing 1,000-thread / 20-project shell workload, the two current-store
passes measured React update commit p95 of 2–3 ms and frame interval p95 of
18–19 ms. This is regression evidence for that synthetic workload, not a measured
speedup from the panel-layout fix. CPU, energy, and physical input latency were
not measured here; see the separate scrolling report for that investigation.

All 118 desktop tests, source and fixture typechecks, lint, production frontend
build, and whitespace checks pass. The build retains its existing large-chunk
advisory. No app, daemon, or user data was replaced. Installed-app packaging
remains unverified because of the earlier Rust E0463 build failure.

Reproduce from `apps/desktop`:

```sh
node scripts/check-rendering.mjs composer-stack
KYBERN_PERF_WIDTH=480 KYBERN_COMPOSER_STACK_MODE=approval node scripts/check-rendering.mjs composer-stack
node scripts/check-rendering.mjs questions
node scripts/check-rendering.mjs prompts
node scripts/check-rendering.mjs work-shell
node scripts/check-rendering.mjs interaction
node --experimental-strip-types scripts/check-window-material.mjs
```

`KYBERN_COMPOSER_STACK_MODE` chooses the final screenshot state: `queue`, `async`,
`blocking`, `approval`, `plan`, or `connector`. Fixture state is synthetic and is
never included in the shipped app.
