# Dock and editor parity pass — October 16, 2026

Worktree: `ade-gpuix-dock2`, branch `gpuix/dock2`, base `91f97a2d`.
Changes are uncommitted. The shared shell/pair-tool update was fast-forwarded from
`feat/gpuix-mvp`; the dock/editor patch was reapplied with `git apply --3way`.
The merged pair-tool core is unchanged. No native changes or new dependencies.

## Changes

- Match desktop dock tab defaults, glyphs, empty states, typography and spacing.
  Diff reads Git status independently of checkpoint availability and retains its
  environment, branch and commit controls. Explorer keeps the desktop tree width.
- Match Notes/Tasks scope headers, sections, counts, list rows and inline footers.
  Project has segmented autonomy/workspace controls, keyboard selection, grouped
  model rows, revisioned brief editing, and the route back to Notes.
- Preview server rows match the desktop grouping and use deterministic servers
  for screenshots. Real preview ticket creation/revocation remains unchanged.
- Terminal tabs use the terminal glyph and cwd name, with new/CLI/close actions.
  Find, Copy, Paste and Scroll to latest moved from the extra footer to a context
  menu; Cmd-F/C/V and Cmd-End retain direct keyboard access.
- Live view uses the image aspect ratio, rounded corners, overlaid caption and
  hover controls. Its drag handle overlays the image without shifting it. Existing
  bounded image crossfade, polling visibility, snapping and dismissal are retained.
- Notes and task description inputs use `DecoratedTextarea` and the shared
  Markdown decoration adapter. Task links are one atomic source range; inline
  code receives the native fill/radius. TaskWindow no longer changes its mounted
  range before asking the native virtual list to scroll.

## Screenshot comparison

Files: `/Users/mymac/projects/ade/previews/gpuix/visual/`.
Each row has `<screen>-{dark,light}-{tauri,gpuix,pair,diff}.png`.
The reference is the desktop React UI in WebKit, compared with the real native
GPUIX renderer. Fixtures use opaque 1280×820 windows (980×820 for narrow), an
isolated daemon and disabled motion. This is not a real Tauri vibrancy/material
comparison. Values are whole-image pixels whose maximum RGB-channel difference
exceeds 24; font rasterization, shell differences and elapsed labels contribute.
A small percentage alone does not establish pixel-identical controls.

| Screen | Dark | Light |
| --- | ---: | ---: |
| dock-agents | 1.29% | 1.20% |
| dock-activity | 1.25% | 1.18% |
| dock-changes | 1.28% | 1.21% |
| dock-explorer | 1.30% | 1.24% |
| dock-review | 1.23% | 1.17% |
| dock-terminal | 1.46% | 1.38% |
| dock-artifacts | 1.68% | 1.54% |
| dock-notes | 1.75% | 2.46% |
| dock-tasks | 3.23% | 3.09% |
| dock-preview | 1.72% | 1.67% |
| dock-add-menu | 1.48% | 1.34% |
| dock-project | 3.41% | 3.31% |
| dock-explorer-file | 1.66% | 1.60% |
| dock-explorer-search | 1.24% | 1.18% |
| dock-diff-file | 1.80% | 1.70% |
| dock-live | 1.43% | 1.51% |
| dock-preview-opened | 1.90% | 1.82% |
| dock-preview-mini | 1.59% | 1.36% |
| dock-narrow | 1.20% | 1.27% |
| dock-resize | 1.35% | 1.24% |
| dock-note-editor | 3.31% | 3.28% |
| tasks-detail | 1.56% | 1.57% |

Project's cropped dark dock content is 6.18% (whole window 3.41%). The crop is
`dock-project-dark-content-pair.png`; it makes the remaining control/rasterization
and model-chip differences easier to review. Native source editor and browser
fallback differences below are intentional capability limits, not pixel parity.

## Validation

- `pnpm typecheck`: pass.
- `bun test ./src`: 43 passed, 402 assertions, zero failures.
- `git diff HEAD --check`: pass.
- Preview integration: rejected unsafe URL, local HTML ticket, server proxy,
  folder-permission state, close and revocation all pass.
- Full Notes verification passed autosave, unmount flush, Quick capture, palette,
  gallery/list, pin/delete/restore and both themes.
- Full Tasks verification passed editing, description formatting, conflict,
  selection, undo, list/board drag and run composer. Edge-scroll/Escape passed.
- Dock verification passed resize, keyboard toggles, tabs, Explorer/Diff and close.
- Final live checks: drag and projected corner snap above the composer, hover
  controls and dismissal pass in dark/light. The old check assumed the window
  bottom; it now checks the actual composer overlay boundary.
- Final runtime checks: Review/Artifacts/Preview/Terminal, device rotation,
  real shell output, scrollback search, exact cell copying, hide/reopen and
  float/return pass in dark/light.
- Dock Notes/Tasks: lazy thread-note creation, in-flight first-save draft,
  autosave, Return task creation and unmount pass in dark/light.
- Combined pointer check: settings switch click/Space, sidebar thread selection,
  titlebar dock toggle, adding Notes and collapse all pass with a real scratch thread.
- Final native check log: `previews/gpuix/dock-v5/validation.log` in the original
  conversation checkout. The initial obsolete live assertion failure is retained
  ahead of the successful rerun.

The Notes/Tasks and first dock checks ran before the shared shell merge; the final
paired captures and typecheck/unit checks ran on the merged base. Timing output
from these interactive checks is not a controlled performance benchmark.

## Limits and remaining differences

- Editable Markdown is source-mode: delimiters and task-link URLs remain visible.
  The native input supports atomic task ranges and code fill/radius, but not the
  web editor's replacement task glyph/key or per-run code font sizing/padding.
- Web pages and HTML artifacts use the existing external-browser fallback.
  There is no embedded WKWebView in this patch. Preview/open/mini fixtures show
  the supported native fallback, rather than pretending to render a webpage.
- The live caption uses a gradient, without the desktop's masked backdrop blur
  or glyph shimmer. Native font rasterization and some fine control borders differ.
- The shared shell still has different coordinator-empty content placement,
  composer details and local/remote environment wording; these files are outside
  this patch. Explorer extension glyphs and preview address chrome also differ.
- Screenshots cover empty Agents/Activity and the fixture states listed above;
  they do not prove every populated lineage/provider runtime combination.

## Cleanup

Stopped both task scratch daemons and all six task Vite processes, including
five orphaned by earlier `--fresh` runs. No task scratch process remains. Scratch
data and the merge safety copy are removed after exporting the patch. No
Rust/native build, dependency install, DerivedData, simulator download or user
normal data modification was performed in this pass.

Free space was approximately 70 GiB at the beginning and 62–63 GiB during the final checks,
with other work running on the same volume. This task's scratch slot was under
10 MiB; the change in free space is not attributed to this patch. Existing
`native/build` (23 MiB) and `node_modules` (225 MiB) are retained for parent
integration. The 58.6 MiB of dock/task-detail screenshots are retained as review
evidence in the original conversation folder and are git-ignored.

Portable patch including new source/fixture/report files:
`/Users/mymac/projects/ade/previews/gpuix/dock-v5/dock-v5.patch`.
Apply from a checkout containing base `91f97a2d`. The worktree itself remains
registered and all source changes remain uncommitted.
