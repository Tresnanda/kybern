# Desktop motion opportunities — 2026-10-20

Motion phase, lane **desktop-audit**. Commit stamp: `98e9bef2b` (v0.10.1, branch `feat/motion-phase2`).
Scope: the Tauri desktop React app in `apps/desktop/src`. This document only plans work. No source files were changed.

The user's request: *"there are parts of kybern that is barely animated / just static animation which is bad, we want lotsa animations, motions, microinteractions, microanimations."*

## How this was produced

- **Runtime walk.** The desktop Vite frontend ran in headless WebKit (Playwright 1.62, WebKit 2336), connected to a scratch `kybernd` 0.10.0.
- **Scratch data.**
  - 2 git projects, 15 threads.
  - Settled turns with thinking, tools, edits, a table and a code block.
  - One turn that is streaming continuously.
  - One failed turn, one pending Bash approval, one pending `AskUserQuestion`.
  - 10 tasks, 5 notes, and dock panels for Changes, Terminal, Agents, Activity, Diff, Tasks and Preview.
- **The driver** was an offline Claude-shaped fake (`previews/motion/desktop-audit/fake-claude-driver.py`). No real agent ran.
- **Recording.** Every interaction recorded `document.getAnimations()` for 0.7–14 s: which element animated, which property, the duration and the easing. "Static" below therefore means *measured: zero animations*, not "looks static".
- **Code sweep.** All four ownership areas were swept read-only, and each high-impact claim was re-checked at its file:line.
- **Rules used.** Every candidate went through the **Gate** from `find-animation-opportunities`, applied per surface with no 5–7 cap, as the brief overrides it:
  1. Frequency
  2. Purpose
  3. Speed budget
  4. Function

  Existing motion was audited against the eight `improve-animations` categories. Timing, easing and choreography follow `motion-design` with the Corporate/Premium personality.

**Evidence:** `/Users/mymac/projects/ade/previews/motion/desktop-audit/`
- About 190 screenshots: `*-mid.png` is 60 ms into an interaction, the plain name is the settled state.
- `probe-s1…s5.txt`: the measured animation lists per interaction.
- `probe-lib.mjs`: the probe itself.

### Counts

| | |
| --- | --- |
| Surfaces walked | 26 (rail, rail usage, sidebar, draft/home, composer + 6 pickers, transcript settled/live/failed, approvals, questions, scroll rail, dock shell + 9 panels, explorer, terminal, preview, lineage, notes gallery/editor, tasks list/board/page/quick add, PRs, usage, settings, palette, dialogs, menus/popovers/tooltips/toasts, theme switch, reduced motion) |
| New motion proposals kept | **99** (88 surface items + 11 shared primitives in package 0) |
| Fixes to existing motion | **62** |
| Candidates rejected by the Gate | **21** (Part 4) |
| Items to mirror in GPUIX (`M`) | **136** of 161 |
| New tokens | **1** (`--ease-exit`) |

### What the walk measured (headline evidence)

| Interaction | Measured | File |
| --- | --- | --- |
| Rail → Tasks, Usage, PRs | Page content: **0 animations** (only the rail pill moves). | `probe-s1-dark.txt` `nav-tasks`, `nav-usage` |
| Rail → Notes | Bare 160 ms opacity fade with the CSS `ease-out` keyword. | `nav-notes` |
| Rail → Home, and ⌘[ / ⌘] back to Home | Replays a **500 ms** `t-stagger-in` on the logo, heading and composer, even on keyboard navigation. | `nav-home`, `nav-back-key`, `nav-forward-key` |
| ⌘K | 250 ms scale + blur + backdrop on a keyboard action that happens 100+ times a day. | `palette-open` |
| Opening a thread whose turn is streaming | **2,024 simultaneous `filter` + `opacity` transitions** on `span.t-stream-w`: the whole live block re-fades. | `probe-s2-dark.txt` `open-running-thread` |
| Thread → thread | 0 animations. Correct, and kept that way (rejected R1). | `open-thread` |
| Tasks: board switch, task open, quick add, task hover | 0 animations each. | `probe-s3-dark.txt` |
| Approval card | Enters as a bare 350 ms opacity fade (`composer-panel-enter`) and leaves with no animation. | `open-approval`, `approve-once` |
| Live → settled turn | Settled chrome (footer, hairline, "Worked for") appears with 0 animations. | `probe-s4-dark.txt` `settle` |
| Dock open/close | Framer animates `width` (layout) plus a 550 ms opacity spring, and it **still runs under reduced motion**. | `dock-open`, `probe-s5.txt` |
| Sidebar open/close, Notes/Tasks/Usage switch | Animates `width`, `padding-left` and both border radii (layout and paint). | `sidebar-toggle-*` |
| Thread row hover | Animates `padding-right` (layout) at 100+/day. The colour transition is silently dropped. | `sidebar-row-hover` |
| Switch thumb | `translate .2s ease-out` literal; still moves under reduced motion. | `settings-switch`, `probe-s5.txt` |
| Theme switch | Root view transition, 280 ms. Correct, kept. | `theme-light` |

---

## Part 1 — Summary table

Legend:
- **Pkg** is the work package (0–4, Part 3).
- **K** is the kind: `N` new motion, `F` fix to existing motion.
- **Freq**: `100+`, `tens`, `occ` (occasional), `rare`; `K` means keyboard-triggered.
- **M**: mirror to GPUIX (`apps/gpuix`).

### Package 0 — shared primitives

| ID | K | Surface | Today | Change | Freq | M |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1 | N | all | No exit token; exits use ease-in-out or literals | `--ease-exit` token | – | M |
| 0.2 | N | all | Conditional UI pops in and out | `.t-appear` with `[data-leaving]` (transition-based enter/exit) | – | M |
| 0.3 | N | all | 3 hand-rolled presence hooks | `usePresence(show, exitMs)` in `motion.tsx` | – | M |
| 0.4 | N | pages | Bare fade, or a hard cut | `.t-page-enter` (opacity + 6px rise, no blur) | – | M |
| 0.5 | N | loaders | `chat-mount-loader-in` keyframes missing; spinners pop in | `.t-delayed-in` | – | M |
| 0.6 | N | errors | None | `.t-shake` | – | M |
| 0.7 | N | lists | None | `.t-flash` ("this just landed" tint) | – | M |
| 0.8 | N | badges | No exit | `.t-pop-out` | – | M |
| 0.9 | N | lists | None | `useFlipList` (transform-only reorder/remove) in `lib/flip.ts` | – | M |
| 0.10 | N | Draft, empties | 500 ms stagger everywhere | `.t-stagger[data-tempo="quick"]` | – | M |
| 0.11 | N | icon swaps | 250 ms only | `IconSwap tempo="quick"` (150 ms) | – | M |
| 0.12 | F | live text | 2,024-word re-fade on mount | `StreamWords` animates only words appended after mount | HIGH | M |
| 0.13 | F | icon swap | Incoming icon uses ease-in-out | In: `--ease-smooth-out`; out: quick `--ease-exit` | MED | M |
| 0.14 | F | dock panes | Scale resamples terminal/iframe; no mount enter; symmetric | `t-pane`: translate only, `@starting-style`, quick exit | MED | M |
| 0.15 | F | loops | `t-shimmer`, task breathe and skeleton run offscreen/hidden; skeleton has no reduce rule | Pause rules + reduce | HIGH | M |
| 0.16 | F | sliding pill | Stale when a tab's width changes; persistent `will-change` on width/height | Observe tabs; `will-change: transform` only | MED | M |
| 0.17 | F | reduced motion | New classes uncovered | Extend the reduce block | – | M |

### Package 1 — shell

| ID | K | Surface | Today | Change | Freq | M |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | N | Page switch (rail) | Hard cut | `t-page-enter` keyed on page, pointer only | tens | M |
| 1.2 | F | Draft stagger | 500 ms on every mount, including ⌘N and ⌘[ | Quick tempo; skip for keyboard and history | HIGH | M |
| 1.3 | F | Palette ⌘K | 250 ms scale + blur | Instant when keyboard-opened; animate when pointer-opened | HIGH | M |
| 1.4 | F | Dock open/close | `width` spring, 550 ms, no reduce, symmetric exit | Instant for ⌘J; quick tween exit; reduce path; measured gate | HIGH | M |
| 1.5 | F | Sidebar drag-resize | Width transitions lag the pointer | Disable transitions while `data-resizing` | MED | – |
| 1.6 | F | Thread row hover | Animates `padding`; drops the colour transition | Padding instant; restore colour transition | HIGH | – |
| 1.7 | F | Full-width press | Recents header and env trigger scale | Brightness only | LOW | – |
| 1.8 | F | Hover-hide classes | Bare `transition-opacity` | Tokens | LOW | – |
| 1.9 | F | Offcanvas literals | 260/200 ms literal curve; radius 200 vs 260; permanent will-change; radius ignores reduce | Tokens, synced radius, transient will-change | LOW | – |
| 1.10 | N | Archive/remove row | Instant, list jumps | Row leaves, siblings FLIP up | tens | M |
| 1.11 | N | Pin/unpin | Glyph snaps, row teleports | IconSwap pin; FLIP to the new slot | tens | M |
| 1.12 | N | Sidebar status glyph | Hard swap (spinner, dot, clock) | IconSwap quick | 100+ passive | M |
| 1.13 | N | Show N more / less | Rows pop; label snaps | Micro-cascade in, quick out; TextSwap label | occ | M |
| 1.14 | N | Subagent children expand | Instant | DisclosureRegion | tens | M |
| 1.15 | N | Rail review badge | Pops | `t-pop` in, `t-pop-out` out | occ | M |
| 1.16 | N | Rail usage | Rings pop in; caption snaps | Arc fills from 0 when fresh; TextSwap caption | occ | M |
| 1.17 | N | Rail update button | Pops into the rail | `t-pop` with bounce (delight budget) | rare | M |
| 1.18 | N | Pending pill / draft pencils | Pop in, vanish | `t-pop` / `t-pop-out` | tens passive | M |
| 1.19 | N | Split view open/close | New pane appears, sibling jumps | Pane `t-appear` (scale variant); keyboard instant | occ | M |
| 1.20 | N | Environment switcher status | Spinner/dot snap | `t-delayed-in` spinner; dot colour transition | occ | M |
| 1.21 | N | Env dialog modes | Content hard-swaps | `t-section-enter` keyed on mode | rare | M |
| 1.22 | F | WorktreeCleanup | Exit killed by `key` remount | Keep mounted through the exit | LOW | – |
| 1.23 | F | SessionsDialog | Always `instant`, mostly pointer-opened | Instant only for keyboard | MED | M |
| 1.24 | N | AppUpdate / GpuixPrompt copy | Icon/label snaps | IconSwap + TextSwap | rare | M |
| 1.25 | F | Toaster position flip | Existing toasts jump | Keep one position | LOW | – |
| 1.26 | N | Handoff spinner ↔ arrow | Snap | IconSwap | rare | M |
| 1.27 | N | Leading controls on Notes | Vanish while the panel slides | `t-appear` fade with the panel | tens | M |
| 1.28 | F | Settings exit literal | `[0.4,0,1,1]` literal | `--ease-exit` | LOW | – |
| 1.29 | N | Tray chips | Labels snap (Checkout ↔ New worktree, branch) | TextSwap | tens | M |
| 1.30 | F | `useResize` | `setWidth` on every pointermove, unthrottled | Coalesce to rAF | MED | – |

### Package 2 — chat

| ID | K | Surface | Today | Change | Freq | M |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 | N | Live → settled turn | Hard cut of the chrome | "Working" → "Worked for" TextSwap; footer `t-appear`; hairline scaleX | 100+ passive | M |
| 2.2 | N | Error / Stopped / Reverted lines | Pop | `t-row-enter` when fresh | occ | M |
| 2.3 | F | Approval/question/secret/coordinator panels (enter) | Bare 350 ms opacity | Opacity + 6px rise, fast | MED | M |
| 2.4 | N | Same panels (exit on resolve) | Unmount instantly | Quick leave (`usePresence`) | tens | M |
| 2.5 | N | Send ↔ stop button | Hard conditional swap | IconSwap quick in one slot | 100+ passive | M |
| 2.6 | F | Send spinner | Smooth `animate-spin` inside glass | Stepped `Spinner` | LOW | – |
| 2.7 | N | Queue/steer chip group | Pops in | `t-appear`; TextSwap label | tens | M |
| 2.8 | F | Slash/mention active row | 100 ms colour lag on arrow keys | No transition for highlight | MED | M |
| 2.9 | N | Attachment chip remove | Instant | `t-pop-out` | occ | M |
| 2.10 | N | Uploading row | Pops | `t-appear` | occ | M |
| 2.11 | F | Model picker close | Panel unmounts; exit shows an empty box | Keep the panel through the exit | HIGH | – |
| 2.12 | N | Model picker tabs | Background jump | Sliding pill | tens | M |
| 2.13 | N | Model star | Hard swap | IconSwap + `t-pop` | occ | M |
| 2.14 | F | "Loading thread" loader | Never shows (keyframes missing, forwards fill) | `t-delayed-in` | HIGH | – |
| 2.15 | F | Scroll-to-bottom | Always mounted with backdrop-blur; drops down to appear | Mount on show; rise from below | MED | M |
| 2.16 | F | Bubble hover actions/time | Bare opacity, default ease | `t-reveal` tokens | LOW | M |
| 2.17 | N | Tool row status | Label snaps; shimmer cuts off | TextSwap present → past | 100+ passive | M |
| 2.18 | N | Approval row text/tone | Snap | TextSwap + colour transition | tens | M |
| 2.19 | N | Notice rows | Pop | `t-row-enter` when fresh | occ | M |
| 2.20 | N | Edited files card | Pops after diff loads | `t-appear` | tens | M |
| 2.21 | F | Copy timers | 1400 ms timers never cleared | Clear on unmount | LOW | – |
| 2.22 | F | ResponseImage | `loaded` not reset on URL change; lightbox original pops | Reset; `t-img` on the original | MED | M |
| 2.23 | N | Lightbox open | Centre pop | Zoom from the thumbnail rect (FLIP) | occ | M |
| 2.24 | N | Visual reply expand/collapse | Instant | Zoom from the card rect; backdrop fade | occ | M |
| 2.25 | N | Question step change | Keyed hard swap | Direction-aware `t-section-enter` | occ | M |
| 2.26 | F | Question footer buttons | `transition: scale` override drops hover colour | Add the colour properties back | LOW | – |
| 2.27 | N | Queued row | Remove instant; body expand instant | `usePresence` leave; DisclosureRegion | occ | M |
| 2.28 | F | `chat-message-send-enter` | Persistent `will-change` on every fresh bubble | Remove | MED | – |
| 2.29 | F | Environment inset | `padding-right` transition on the whole transcript | Snap padding; slide only the card | HIGH | M |
| 2.30 | N | Message rail | Rail pops; ticks mount at full size; virtual rail preview instant | Fade rail; new tick scaleX; virtual preview presence | occ | M |
| 2.31 | F | `lib/beui/ease.ts` | `EASE_OUT` ≠ `--ease-out` | Align | LOW | – |
| 2.32 | N | Held messages deliver/dismiss | Row vanishes | `usePresence` leave | occ | M |
| 2.33 | F | Subagent strip time ↔ actions | Bare crossfade | `t-reveal` nudge | LOW | M |
| 2.34 | N | Subagent page status text | Hard swap | TextSwap | tens | M |
| 2.35 | N | Coordinator outcome icon | Hard swap | IconSwap | occ | M |
| 2.36 | F | ComputerLiveView | `EXIT_MS` 150 vs CSS 160; size toggle animates width/height | 160 ms; scale-based resize | LOW | – |
| 2.37 | N | Activity glyph | check ↔ spinner snap | IconSwap | occ | M |
| 2.38 | N | Mermaid | Diagram pops; preview ↔ source hard swap | `t-img`; `t-pane` pair | rare | M |
| 2.39 | N | Artifacts / NativeSubagentComposer "Sending…" | Plain swap | TextSwap | rare | M |
| 2.40 | F | Live caret | Attaches to `table::after` / `codeblock::after` | Only after text blocks | LOW | M |
| 2.41 | F | Send double-show | Text can show in the composer and the bubble at once | Clear the editor at send, restore on error | MED | M |
| 2.42 | F | `ultrathink-*` loops | Linear background-position repaint, no reduce, no pause | Reduce + pause | MED | – |
| 2.43 | N | Delegation conflict badge / override text | Pop | `t-pop` / `t-appear` | occ | M |

### Package 3 — dock

| ID | K | Surface | Today | Change | Freq | M |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 | F | Hidden dock panes | Reachable by Tab (`aria-hidden` only) | `inert` (a11y; found during the motion walk) | MED | M |
| 3.2 | N | Dock tab add/close | Chip pops; siblings jump | `t-appear` (scale); FLIP siblings | occ | M |
| 3.3 | N | Preview-unseen dot | Pops | `t-pop` | occ | M |
| 3.4 | N | Changes pane states | Spinner/count/PR row snap | IconSwap, TextSwap, `t-pop` on DiffStat | tens | M |
| 3.5 | N | Dock empty states | Static | Quick stagger | occ | M |
| 3.6 | N | Tasks dock | Rows pop; ring jumps; loading blank | `t-row-enter` fresh + leave; ring dashoffset transition; delayed skeleton | tens | M |
| 3.7 | N | Notes dock | Rows pop | `t-row-enter` fresh | occ | M |
| 3.8 | N | Project dock edit | Label snaps; layout jump | TextSwap; `t-section-enter` | occ | M |
| 3.9 | N | Preview chrome | Site icon snaps; "Open in browser" bare fade; toolbar/notices pop | IconSwap; `t-reveal`; `t-appear` | tens | M |
| 3.10 | N | Preview states | All mount instantly; "Waiting" text snaps | `t-section-enter` shell; TextSwap | occ | M |
| 3.11 | F | Preview server rows | `w-full` + `press` = no press feedback | `press-row` | LOW | – |
| 3.12 | F | Mini-player exit origin | `--pip-origin` never set | Set per corner | MED | M |
| 3.13 | N | Mini-player enter | Teleports to the corner | Scale/translate from the dock rect | rare | M |
| 3.14 | F | PreviewSurface fade | 150 ms, out of step with the 250 ms pane | Align to the pane token | LOW | – |
| 3.15 | F | Explorer copy | No feedback | IconSwap check | occ | M |
| 3.16 | F | File tree first load / search clear | Whole tree staggers again | `initial={false}` on first commit and remounts | MED | M |
| 3.17 | N | File tree collapse | Children vanish | AnimatePresence exit (≤150 rows) | tens | M |
| 3.18 | F | File tree hover pill | One blur wrapper per row | Single pill | MED | – |
| 3.19 | N | File viewer open (pointer) | Skeleton → content snap | `t-section-enter` keyed by path | tens | M |
| 3.20 | N | Markdown Source/Preview | Background jump | Sliding pill | occ | M |
| 3.21 | F | Terminal tab pane | Bare `transition-opacity`, no reduce | Token + reduce, opacity only | LOW | M |
| 3.22 | N | Terminal tab chip add/close/exit | Pop / vanish | `t-appear` + leave; exited tab leaves | occ | M |
| 3.23 | N | Terminal chip icon ↔ close | Overlapping fade | `t-icon-swap` | tens | M |
| 3.24 | N | DiffView body | `{open && …}` hard toggle | DisclosureRegion (matches transcript) | tens | M |
| 3.25 | N | Lineage status glyph (`ChildGlyph`) | Hard swap (also in delegation rows) | IconSwap | tens passive | M |
| 3.26 | F | Lineage hover actions | Bare opacity crossfade; no press | `t-reveal`; `press` | LOW | M |
| 3.27 | N | Lineage tree expand | Children pop | Micro-cascade `t-row-enter`; leave | tens | M |
| 3.28 | F | Environment card | Same speed in and out | Quick exit | LOW | M |
| 3.29 | N | Environment card sections | Pop; height jump | DisclosureRegion | occ | M |
| 3.30 | N | Chat pane drag | Preview appears flat; vanishes on cancel; zone jumps | Lift; settle back; zone glides | occ | M |
| 3.31 | F | ResizeHandle line | Flashes on pass-over | 120 ms hover delay; tokens | LOW | M |

### Package 4 — pages and kit overlays

| ID | K | Surface | Today | Change | Freq | M |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 | F | Context menus | tw-animate classes inert: no motion at all | Menu popup recipe | HIGH | M |
| 4.2 | F | Select popup | No motion | Menu popup recipe | HIGH | M |
| 4.3 | F | Combobox/autocomplete popups | Transition on a dead wrapper span | Move to the popup | MED | M |
| 4.4 | F | AlertDialog, Sheet | `transition-all`, ease-in-out, symmetric, no reduce | Align with Dialog | MED | M |
| 4.5 | F | Preview card | Default 150 ms ease; no reduce | Tokens + reduce | LOW | M |
| 4.6 | F | Checkbox uncheck | Instant (`data-unchecked:hidden`) | Quick reverse | LOW | M |
| 4.7 | F | Switch | Literal `ease-out`; no reduce | Tokens + reduce | MED | M |
| 4.8 | F | Disclosure | Untokenised 220 ms; symmetric; inner drift only on close | Tokens; quick close; drift on open | MED | M |
| 4.9 | F | Skeleton / `animate-pulse` | No reduce | Reduce; static under reduce | MED | – |
| 4.10 | F | Tooltip/popover positioner | top/left transition ignores reduce | Reduce | LOW | – |
| 4.11 | N | Notes: gallery → editor | Doc rises, gallery hard-cuts | Doc scales from the clicked card origin | tens | M |
| 4.12 | N | Notes format bar / link bubble | Pops on selection; modes snap | Pop from the selection (bottom origin); mode `t-section-enter` | tens | M |
| 4.13 | N | Note delete | Card vanishes | `t-pop-out` | occ | M |
| 4.14 | N | Notes list ↔ gallery | Hard re-layout | `t-section-enter` keyed on layout | occ | M |
| 4.15 | N | Notes empty / first run | Static | `t-stagger` | rare | M |
| 4.16 | F | `notes-enter` | Bare 160 ms fade, keyword ease | Replaced by 1.1 | LOW | – |
| 4.17 | N | Notes outline rail | Width snaps on hover | Labels fade/slide in, width snaps | tens | M |
| 4.18 | N | Tasks list ↔ board | Hard swap; segment snaps | `t-section-enter`; sliding pill | occ | M |
| 4.19 | N | Task created | Appears silently | `t-flash` on the new row/card | tens (K) | M |
| 4.20 | N | Task status change | Row/card teleports between groups | FLIP (pointer); flash (keyboard) | tens | M |
| 4.21 | N | Task check | Fill/tick instant | Fill transition + `t-check-path` draw + glyph `t-pop` on done | tens | M |
| 4.22 | N | Acceptance criteria tick | Mounts | `t-check-path` draw | tens | M |
| 4.23 | F | Board/list drag | dnd-kit default 250 ms ease; flat pickup | Pickup lift; tokenised drop/sort | MED | M |
| 4.24 | N | Task groups collapse; "N more" | Instant | DisclosureRegion; cascade | occ | M |
| 4.25 | N | Task page open (pointer) | Hard cut | `t-page-enter` (pointer only) | tens | M |
| 4.26 | N | Tasks hints bar / empty / error | `visibility` snap; static | Fade; `t-stagger` | rare | M |
| 4.27 | N | PR tab panels | Hard swap | `t-section-enter` (pointer) | tens | M |
| 4.28 | N | PR list after loading | Rows replace the skeleton | Micro-cascade, first load only | occ | M |
| 4.29 | N | PR review submit | Text snaps; silent close; error pops | TextSwap; success check; `t-shake` | occ | M |
| 4.30 | F | PrHeader copy | Icon snaps (the top bar uses IconSwap) | IconSwap | LOW | M |
| 4.31 | N | PR checks rows; checks ring | `display` toggle; ring static | DisclosureRegion; dashoffset transition | occ | M |
| 4.32 | N | Usage daily bars | `height%` snaps on period change | `scaleY` transition + one-time grow | occ | M |
| 4.33 | N | Usage breakdown meters | `width%` snaps | `scaleX` transition | occ | M |
| 4.34 | N | Limit meter | Mounts at its value | Fill from 0 when fresh | occ | M |
| 4.35 | N | Usage group segments | Background snap | Sliding pill | occ | M |
| 4.36 | N | Settings save failure | Toast only | `t-shake` on the row | rare | M |
| 4.37 | F | Theme choice | Plain `ease` | Tokens | LOW | – |
| 4.38 | N | Integrations | `animate-pulse`; segments snap; status remounts | Delayed static skeleton; pill; TextSwap | rare | M |
| 4.39 | N | Add account | Step exit missing; copy snaps; wrong code silent | Step leave; IconSwap; `t-shake` | rare | M |
| 4.40 | N | Toasts (sonner) | Library default | Align enter/exit to `t-toast` (blur clears) | occ | M |

---

## Part 2 — Shared conventions for every package

These rules are binding. Read them before any package.

**Tokens.** All tokens live in `apps/desktop/src/styles/motion.css`.

| Token | Value | Use |
| --- | --- | --- |
| `--duration-micro` | 80ms | press-in, highlight snaps, tooltip exit |
| `--duration-quick` | 150ms | exits, small popovers, hover reveals |
| `--duration-fast` | 250ms | enters of rows, panels, menus, pills |
| `--duration-medium` | 350ms | composer-stack panels, toasts |
| `--duration-slow` | 400ms | meters, rings, images |
| `--duration-very-slow` | 500ms | rare/first-run staggers, success check |
| `--duration-stagger` | 40ms | stagger step |
| `--ease-smooth-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | **every entrance** |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | hover, colour, press, meters |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | on-screen morphs only |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | sidebar/drawer travel |
| `--ease-spring` + `--duration-spring` | linear() spring, 450ms | sliders, settle |
| `--ease-bounce` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | light pops only (badges, checks) |
| **new** `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | **every exit** (0.1) |
| `--distance-micro` / `small` / `base` / `medium` | 4 / 6 / 8 / 12 px | travel |
| `--blur-small` / `medium` / `large` | 2 / 3 / 8 px | entrance blur |

**Rules.**
1. **Properties.** Animate `transform`, `opacity` and `filter` only. No `width`, `height`, `padding`, `margin`, `top`/`left` or `grid-template-*` unless an item explicitly keeps an existing one. `background-color`, `color` and `border-color` are allowed for hover and state changes.
2. **No bare cross-fades.** Every fade carries a 4–6 px nudge or a 2 px blur. Do not blur whole panes, the terminal canvas, preview iframes, or elements inside a `backdrop-filter` surface; use the nudge there.
3. **Enter and exit.**
   - Enter: `--duration-fast` with `--ease-smooth-out`.
   - Exit: `--duration-quick` with `--ease-exit`, about 40% faster than the enter.
   - Rapidly toggled UI uses transitions or `@starting-style`, not keyframes.
4. **Keyboard is instant.** Use `lastInputWasPointer()` from `apps/desktop/src/lib/navMotion.ts` to tell pointer from keyboard. Keyboard-triggered moves skip travel and blur. They may at most use the ≤120 ms no-travel `t-flash`.
5. **Fresh items only.** Never animate the initial load or a launch.
   - Use `isLaunching()` (`lib/launch.ts`) and the existing 3 s "fresh" checks.
   - Keyed remounts of old content must not replay entrances.
6. **Reduced motion.**
   - Every class needs a `prefers-reduced-motion: reduce` rule in the block at the end of `motion.css`. In TSX, read `useReducedMotion()` (motion/react) or `matchMedia`.
   - Reduced means opacity only, at ≤150 ms, or nothing at all.
   - Feedback colour changes stay.
7. **No persistent `will-change`.** Do not use forwards fills that keep layers alive. Loops pause offscreen, in hidden windows and in inactive panes (`observeLoopVisibility`, `[data-loop-paused]`, `.t-pane[data-active="false"]`).
8. **Hot paths.** Transcript, Markdown, virtual rows and the scroll pin are hot paths. Read `apps/desktop/perf/README.md` first.
   - Keep turn/row identities stable.
   - Do not add per-frame layout inside `VirtualRows`. Its rows are paint hosts with an 8 px bleed, so keep travel ≤ 6 px.
9. **Do not change** copy, colours, layout or icons. This phase changes motion only.
10. **Code drift.** If a cited excerpt no longer matches the code, **stop and report** instead of improvising.

**Verification for every package.** Run from `apps/desktop`:
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build`.
- The native fixtures named in each package (they need a native macOS run).
- A visual check in the Vite frontend against a scratch daemon in headless WebKit or Safari. Never run `pnpm tauri dev` while the user's app hosts the session.
- A frame-level look. Either use Safari Web Inspector → Timelines → Animations at 10%, or the probe in `previews/motion/desktop-audit/probe-lib.mjs`, which logs every animation an interaction starts.
- The same interaction with `reducedMotion: 'reduce'`.

**Measurement for anything that loops or runs during streaming or scrolling.** Report CPU %, GPU-process CPU %, frame interval p50/p95/p99, and frames over 16.7 ms and over 33 ms, before and after, on the same workload.
- Streaming: `node scripts/check-rendering.mjs`.
- Running work: `node scripts/check-rendering.mjs work-stream`.
- Navigation and row state: `node scripts/check-rendering.mjs interaction`.
- Idle layers: `real-session`.

---

## Part 3 — Work packages

The packages own disjoint files. **Package 0 lands first**; packages 1–4 can then run in parallel.

Shared stylesheets are split by rule block:

| Stylesheet | Package | Rule blocks |
| --- | --- | --- |
| `styles/kit.css` | 1 | `.sidebar-*`, `.chat-content-card.workspace-card`, `--animate-spin-stepped` |
| `styles/kit.css` | 2 | `.chat-*`, `.composer-*`, `.runtime-activity-*`, `.visual-reply*`, `.ultrathink-*`, `.chat-message-send-enter` |
| `styles/kit.css` | 3 | `.preview-*` |
| `styles/kit.css` | 4 | `--animate-skeleton`, `.account-*` |
| `styles/kybern.css` | 1 | `.rail-usage-*`, `.split-thread-pane` focus ring |
| `styles/kybern.css` | 2 | `.question-panel-*`, `.computer-*`, `.t-shimmer` |
| `styles/kybern.css` | 3 | `.thread-drop-*`, `.chat-pane-drag*`, `.split-thread-pane` drop overlay rules |
| `styles/kybern.css` | 4 | `.limit-meter*` |

Do not edit another package's rule blocks. If you need a new shared class, ask for it in package 0's follow-up rather than adding it to `motion.css` yourself.

### Package 0 — shared motion primitives (lands first)

**Owns:**
- `apps/desktop/src/styles/motion.css`
- `apps/desktop/src/components/kybern/motion.tsx`
- `apps/desktop/src/lib/kit/slidingPill.ts`
- `apps/desktop/src/lib/iconSwap.ts`
- `apps/desktop/src/lib/loopVisibility.ts`
- new `apps/desktop/src/lib/flip.ts`

**Items:** 17 (0.1–0.17).

Add the following to `motion.css`. New rules go after the existing section they extend. Reduced-motion rules go in the final `@media (prefers-reduced-motion: reduce)` block.

**0.1 `--ease-exit`.** Add `--ease-exit: cubic-bezier(0.4, 0, 1, 1);` to `:root`, next to `--ease-in-out`. This curve is already in use as a literal in `App.tsx` (the settings exit, `[0.4,0,1,1]`). It is the only new token in this phase.

**0.2 `.t-appear` (enter/exit for conditionally rendered small surfaces).** It is transition-based, so a rapid toggle retargets instead of restarting.

```css
.t-appear {
  transition:
    opacity var(--duration-fast) var(--ease-smooth-out),
    transform var(--duration-fast) var(--ease-smooth-out),
    filter var(--duration-fast) var(--ease-smooth-out);
}
@starting-style {
  .t-appear { opacity: 0; transform: translateY(var(--distance-micro)); filter: blur(var(--blur-small)); }
}
.t-appear[data-leaving] {
  opacity: 0;
  transform: translateY(var(--distance-micro));
  filter: blur(var(--blur-small));
  pointer-events: none;
  transition-duration: var(--duration-quick);
  transition-timing-function: var(--ease-exit);
}
/* Variants: no blur (inside glass, over canvases); enter from above; scale (chips, panes). */
.t-appear[data-blur="off"], .t-appear[data-blur="off"][data-leaving] { filter: none; }
@starting-style { .t-appear[data-blur="off"] { filter: none; } }
.t-appear[data-from="above"][data-leaving] { transform: translateY(calc(var(--distance-micro) * -1)); }
@starting-style { .t-appear[data-from="above"] { transform: translateY(calc(var(--distance-micro) * -1)); } }
.t-appear[data-from="scale"][data-leaving] { transform: scale(var(--scale-medium)); }
@starting-style { .t-appear[data-from="scale"] { transform: scale(var(--scale-medium)); } }
```

- Reduce: `.t-appear { transition: opacity var(--duration-quick) var(--ease-out) !important; }`.
- Also reset `transform: none; filter: none` for the leaving and starting states under reduce.

**0.3 `usePresence`.** Export from `motion.tsx`:

```ts
/** Keeps a node mounted for `exitMs` after `show` turns false so `[data-leaving]` styles can run. */
export function usePresence(show: boolean, exitMs = 150): { mounted: boolean; leaving: boolean }
```

- Mount immediately when `show` turns true. On false, set `leaving`, then unmount after `exitMs` using `window.setTimeout`, cleared on change and on unmount.
- Under reduced motion `exitMs` is 0, read via `matchMedia("(prefers-reduced-motion: reduce)")`.
- Read `--duration-quick` the way `views/useToastPresence.ts` reads `--toast-close`, so the timer and the CSS stay in step. Copy that pattern.
- Callers render `{mounted && <div className="t-appear" data-leaving={leaving || undefined}>…</div>}`.
- Do **not** migrate the existing hooks (`useToastPresence`, `SubagentStrip`'s presence, `SubagentSidebarRow` `LEAVE_MS`) in this package. Their owners may switch later.

**0.4 `.t-page-enter`.** For keyed page roots. There is no blur, because the perf guide forbids blurring whole panes.

```css
.t-page-enter { animation: t-page-enter var(--duration-fast) var(--ease-smooth-out) backwards; }
@keyframes t-page-enter { from { opacity: 0; transform: translateY(var(--distance-small)); } }
```

Reduce: `animation: t-fade-in var(--duration-quick) var(--ease-out) backwards`, with `@keyframes t-fade-in { from { opacity: 0 } }`.

**0.5 `.t-delayed-in`.** For loaders that should only show when work is slow.

```css
.t-delayed-in { animation: t-fade-in var(--duration-quick) var(--ease-out) var(--delay, 150ms) backwards; }
```

`backwards` fill, never `forwards`. This replaces the undefined `chat-mount-loader-in` (2.14) and is what `DelayedSpinner` uses (1.20). Reduce keeps the delay and drops the fade: `animation-duration: 1ms`.

**0.6 `.t-shake`.** For error confirmation (wrong code, failed save, invalid input). Rare or occasional only.

```css
.t-shake { animation: t-shake 320ms var(--ease-in-out); }
@keyframes t-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-3px) } 40% { transform: translateX(3px) } 60% { transform: translateX(-2px) } 80% { transform: translateX(2px) } }
```

- Callers remove the class on `animationend` and re-add it with a key bump to replay.
- Reduce: `animation: none` (the error colour and text remain).

**0.7 `.t-flash`.** "This just landed" tint. It plays on the pseudo-element's opacity, so the content itself never moves. That makes it safe for keyboard actions.

```css
.t-flash { position: relative; }
.t-flash::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: color-mix(in oklab, var(--color-accent-blue, currentColor) 14%, transparent);
  animation: t-flash 700ms var(--ease-out) both;
}
@keyframes t-flash { from { opacity: 1 } to { opacity: 0 } }
```

Callers remove the class on `animationend`. Reduce: keep it, with `animation-duration: 400ms` (an opacity change only).

**0.8 `.t-pop-out`.** Exit partner of `.t-pop`:

```css
.t-pop-out { animation: t-pop-out var(--duration-quick) var(--ease-exit) both; pointer-events: none; }
@keyframes t-pop-out { to { opacity: 0; transform: scale(0.85); } }
```

Use it with `usePresence(show, 150)`. Reduce: `animation-name: t-fade-out`, with `@keyframes t-fade-out { to { opacity: 0 } }`.

**0.9 `lib/flip.ts` — `useFlipList(containerRef)`.**

```ts
export function useFlipList<T extends HTMLElement>(ref: RefObject<T | null>, opts?: { selector?: string; max?: number }): { capture(): void }
```

- `capture()` records `getBoundingClientRect()` for up to `max` items (default 40) matching `selector` (default `[data-flip-key]`) inside the container. Only items intersecting the viewport count.
- A `useLayoutEffect` that runs every render: if a capture is pending, it measures the same keys again. For every moved element it calls `el.animate([{ transform: \`translate(${dx}px, ${dy}px)\` }, { transform: "none" }], { duration: 250, easing: "cubic-bezier(0.22, 1, 0.36, 1)" })`, then clears the capture.
- Cancel a previous animation on the same element first (keep a `WeakMap`), as `lib/navMotion.ts` does.
- Skip entirely when `!lastInputWasPointer()` or reduced motion is set.
- Never use it inside `VirtualRows`, which positions rows itself.
- Callers call `capture()` in the event handler right before the state update.

**0.10 Quick stagger tempo.**

```css
.t-stagger[data-tempo="quick"] > * { animation-name: t-stagger-in-quick; animation-duration: var(--duration-fast); animation-delay: calc(var(--i, 0) * var(--duration-stagger)); }
@keyframes t-stagger-in-quick { from { opacity: 0; transform: translateY(var(--distance-small)); filter: blur(var(--blur-small)); } }
```

Reduce is already covered by `.t-stagger > *`.

**0.11 Quick IconSwap.**
- Add an optional `tempo?: "quick"` prop to `IconSwap`. It sets `data-tempo="quick"` on `.t-icon-swap` and uses a 150 ms settle timer instead of `ICON_SWAP_TRANSITION_MS`. Add `ICON_SWAP_QUICK_MS = 150` to `lib/iconSwap.ts`.
- CSS: `.t-icon-swap[data-tempo="quick"] > * { transition-duration: var(--duration-quick); }`.

**0.12 Fix `StreamWords` replaying on mount (HIGH, hot path).**
- Measured: opening "Find slow queries…" while it streamed started 2,024 `t-stream-w` transitions at once (`probe-s2-dark.txt`, `open-running-thread`). `motion.tsx:90-105` wraps every word in `span.t-stream-w`, and `@starting-style` fades each newly mounted span.
- Target: words present on the **first render** of a `StreamWords` instance render as plain text. Only later indices get the span.
  - Keep `const firstCount = useRef<number | null>(null)`.
  - On first render, set it to the number of non-whitespace tokens.
  - Render `token` plain when its word index is below `firstCount.current`.
- Keys stay index-based, so already-animated words are never touched again.
- Acceptance:
  - Re-run the probe: opening a streaming thread starts ≤ 60 `t-stream-w` transitions in the first 700 ms.
  - A steady stream still fades only the tail.
  - `node scripts/check-rendering.mjs` (streaming) shows frame-interval p95 no worse than baseline.
  - Final text is exact.

**0.13 Fix IconSwap easing.** `motion.css:257-260` gives both icons `--ease-in-out`. Target:

```css
.t-icon-swap > * { transition: opacity var(--duration-fast) var(--ease-smooth-out), transform var(--duration-fast) var(--ease-smooth-out), filter var(--duration-fast) var(--ease-smooth-out); }
.t-icon-swap > [data-active="false"] { transition-duration: var(--duration-quick); transition-timing-function: var(--ease-exit); }
```

**0.14 Fix `t-pane`** (`motion.css:431-446`).
- The hidden state's `scale(0.995)` makes `PreviewSurfaceLayer` rewrite the iframe size every frame (`state/previewSurface.ts:179-190`) and resamples the terminal's WebGL canvas.
- Enter and exit are both 250 ms, and a pane mounted later (an added panel) snaps in.
- Target:

```css
.t-pane { transition: opacity var(--duration-quick) var(--ease-exit), transform var(--duration-quick) var(--ease-exit); }
.t-pane[data-active="false"] { opacity: 0; transform: translateY(var(--distance-micro)); pointer-events: none; }
.t-pane[data-active="true"] { opacity: 1; transform: none; transition-duration: var(--duration-fast); transition-timing-function: var(--ease-smooth-out); }
@starting-style { .t-pane[data-active="true"] { opacity: 0; transform: translateY(var(--distance-micro)); } }
```

The resting `transform: none` also removes the containing block created for `position: fixed` children.

**0.15 Fix loops that do not pause.**
- `.t-shimmer` (`kybern.css:197`) is a linear infinite `background-position` on `::before`. It repaints and is not paused offscreen or in inactive panes.
- `task-breathe` (`tasks.css:112-130`) and `animate-skeleton` (`kit.css:6`) keep running inside opacity-0 panes. `animate-skeleton` has no reduce rule.
- Add to `motion.css`:

```css
.t-shimmer[data-loop-paused]::before,
.t-pane[data-active="false"] .t-shimmer::before,
.t-pane[data-active="false"] .task-glyph-breathe,
.t-pane[data-active="false"] .animate-skeleton,
[data-loop-paused] .animate-skeleton { animation-play-state: paused; }
```

- In `TextSwap`, when `shimmer` is true, attach `observeLoopVisibility` to the shimmering span. This is the same pattern `MatrixLoader` uses (`motion.tsx:66-69`).
- Reduce block: add `.animate-skeleton, .t-shimmer::before { animation: none !important; }`.
- Measure: a thread with "Thinking" scrolled offscreen, and dock Tasks hidden. WebContent and GPU-process CPU before and after, following the method in `perf/README.md` §Matrix loader.

**0.16 Fix the sliding pill** (`lib/kit/slidingPill.ts:25-42`, `motion.css:396-415`).
- The pill re-measures only on container resize or an active-key change, so a badge that widens a tab leaves it stale (dock `RightPanel.tsx:118-120`).
- In the layout effect, also `observeResizeFrame` each `[data-tab-active]`-bearing child of the container. Collect them with `node.querySelectorAll('[data-tab-active]')` and re-observe when the list changes.
- CSS: change `will-change: transform, width, height` to `will-change: transform`. The width/height transition stays; the pill is a small absolutely positioned element.

**0.17 Reduced motion.** Add every new class above to the final reduce block, as specified per item. Fix the stale comment in `components/kit/chat/ComposerMentionChips.tsx:3`, which claims the pill slides under reduced motion; it does not. That is a comment-only edit, and it is the one file outside this package's list that package 0 may touch.

**Package 0 verification.**
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- `node scripts/check-rendering.mjs`, plus the matrix fixture (`perf/matrix.html`, §Matrix loader) to confirm loops still pause.
- `node scripts/check-rendering.mjs interaction`.
- Under the probe, every new class shows its exact duration and easing, and nothing new runs at idle (`document.getAnimations()` is empty on an idle settled thread except the existing indicators).

### Package 1 — shell, navigation, sidebar, palette

**Owns:**
- `App.tsx`
- `views/NavRail.tsx`, `views/RailUsage.tsx`, `views/Sidebar.tsx`
- `views/subagents/SubagentSidebarRow.tsx`
- `components/kit/sidebar.tsx`, `lib/kit/sidebarRowStyles.ts`
- `views/Palette.tsx`, `components/kit/command.tsx`
- `views/Draft.tsx`, `views/trayChips.tsx`, `views/chrome.tsx`
- `views/Handoff.tsx`, `views/SessionsDialog.tsx`
- `views/EnvironmentSwitcher.tsx`, `views/SplitThreads.tsx`
- `views/AppUpdate.tsx`, `views/GpuixPrompt.tsx`, `views/WorktreeCleanup.tsx`
- `components/theme-provider.tsx`, `lib/launch.ts`, `lib/hooks.ts` (`useResize` only)
- The kit.css/kybern.css rule blocks listed above

**Items:** 30.

**Native checks:**
- `node scripts/check-rendering.mjs work-shell`
- `free-chat`
- `chat-coordinator`
- `app-update`
- `interaction`
- `real-session` (idle shell layers)

#### 1.1 Page switch from the rail (N, tens/day, M)

- **Files.** `App.tsx:264-294` (the main content switch).
- **Today.** Hard cut. Measured 0 content animations for Tasks, Usage and PRs. Notes plays its own bare 160 ms fade.
- **Trigger.** Pointer click on a rail destination.
  - Keyboard (⌘[ / ⌘], ⌘N, shortcuts) stays instant.
  - Ordinary thread ↔ thread stays instant.
- **Motion.**
  - Wrap each top-level page (Pulls, Usage, Notes, Tasks, Draft) in a div with `className={animate ? "t-page-enter" : undefined}`, keyed on the page.
  - `animate = lastInputWasPointer() && !isLaunching()`, captured at the navigation moment. Store it in a ref when the page key changes.
  - Enter: `--duration-fast`, `--ease-smooth-out`, opacity 0 → 1 and `translateY(6px)` → 0.
  - There is no exit: the old page unmounts at once, so content is never doubled.
- **Interruptible.** Yes. The new key restarts the animation from the new page only.
- **Reduced motion.** `t-page-enter` reduce rule: 150 ms opacity.
- **Perf.** One transform/opacity animation on the page root. No blur, per the perf guide's whole-pane rule. Inspect the `t-page-enter` element's layer only while it animates.
- **Dependency.** Package 4 removes the `notes-enter` page fade (4.16) once this lands.
- **Accept.**
  - The probe shows exactly one `t-page-enter` (250 ms) on rail clicks, and none for ⌘[ / ⌘].
  - The first connected paint shows none.

#### 1.2 Draft stagger replays on every mount (F, HIGH, M)

- **Files.** `views/Draft.tsx:51,112,150-151`.
- **Today.** `t-stagger` (500 ms + 70 ms per item, 12 px, 3 px blur) plays on every remount, including ⌘N, ⌘[ back to Home and project switching. Measured in `nav-back-key` and `nav-forward-key`.
- **Target.**
  - Apply `t-stagger` only when `lastInputWasPointer() && !isLaunching()` at mount, and add `data-tempo="quick"` (0.10): 250 ms, 40 ms steps, 6 px, 2 px blur.
  - Keyboard and history navigation render settled.
  - Remove `active:scale-[0.96]` from the free-chat chip (`:198`), which is a menu trigger. `motion.css` already gives menu triggers the brightness press.
- **Accept.**
  - ⌘N and ⌘[ start 0 `t-stagger-in*` animations.
  - A rail click on Home starts `t-stagger-in-quick` at 250 ms.

#### 1.3 Palette ⌘K animates (F, HIGH, M)

- **Files.** `components/kit/command.tsx:34,59`, `views/Palette.tsx`.
- **Today.** Measured: 250 ms scale + blur + backdrop on ⌘K (`palette-open`), and 150 ms on close.
- **Target.**
  - Add an `instant?: boolean` prop to `CommandDialogPopup` and the backdrop, mirroring `components/kit/dialog.tsx:78-99`: `instant && "transition-none"` on both.
  - `Palette.tsx` passes `instant={!lastInputWasPointer()}`, captured when it opens.
  - The sidebar Search button (pointer) keeps the current animation.
- **Accept.** ⌘K and Escape start 0 animations. Clicking the sidebar Search icon starts the 250 ms recipe.

#### 1.4 Dock open/close (F, HIGH, M)

- **Files.** `App.tsx:80` (`DOCK_MOTION`) and `:297-318`.
- **Today.**
  - A Framer spring animates `width` 0 → dockWidth (layout every frame across the chat column) plus opacity. Measured at 550 ms.
  - The same spring runs for exit and under reduced motion (`probe-s5.txt`).
  - ⌘J animates too.
- **Target.**
  - Keyboard (⌘J) and reduced motion: `transition={{ duration: 0 }}`. Under reduced motion, fade opacity only: `{ width: { duration: 0 }, opacity: { duration: 0.12 } }`.
  - Pointer open: keep the spring.
  - Exit: `{ type: "tween", duration: 0.18, ease: [0.4, 0, 1, 1] }`, which is faster than the enter and uses the `--ease-exit` values.
  - Use `useReducedMotion()`, already imported at `App.tsx:122`.
- **Perf gate.**
  - Measure frame intervals during pointer open over a long transcript (`node scripts/check-rendering.mjs interaction`, or the probe with a rAF interval log).
  - If p95 is over 16.7 ms, switch to a transform reveal:
    - Set the `width` instantly at start.
    - Animate the inner `div` (`:311`) from `translateX(24px)` + opacity 0 to rest at 250 ms `--ease-smooth-out`.
    - Report both numbers.
- **Accept.** ⌘J starts 0 animations. Reduced motion shows only a ≤120 ms opacity change. Pointer close completes in 180 ms.

#### 1.5 Sidebar drag-resize lags the pointer (F, MED)

- **Files.** `components/kit/sidebar.tsx:367,385`, `lib/hooks.ts:176-220`.
- **Today.** The gap width (260/200 ms) and shell `left/right/width` transitions stay on while `useResize` writes `--sidebar-width` on every pointermove. `html[data-resizing]` is already set (`hooks.ts:200`).
- **Target.** In `kit.css` (the shell block), add `html[data-resizing] [data-slot="sidebar-gap"], html[data-resizing] [data-slot="sidebar-container"], html[data-resizing] .app-titlebar-slot { transition: none !important; }`.
- **Accept.** While dragging, the probe shows no `width` transitions, and the edge tracks the pointer.

#### 1.6 Thread row hover animates padding and loses its colour transition (F, HIGH)

- **Files.** `views/Sidebar.tsx:783-790` (also `:597` for project rows).
- **Today.** `transition-[padding] duration-150 ease-out` is merged after `SIDEBAR_THREAD_ROW_BASE_CLASS_NAME`, whose `transition-colors` tailwind-merge then drops.
  - Measured: `padding-right` 150 ms on every row hover (`sidebar-row-hover`), which is layout at 100+/day.
  - The background colour snaps.
- **Target.** Delete the `transition-[padding] duration-150 ease-out` token from both rows. Padding changes instantly; the `t-reveal` toolbar already fades and slides in. The base class's `transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)]` then applies again.
- **Accept.** Row hover shows `background-color` 150 ms and the `t-reveal` opacity/transform, and no `padding-*`.

#### 1.7 Full-width rows scale on press (F, LOW)

- **Files.** `views/Sidebar.tsx:288`, `views/EnvironmentSwitcher.tsx:120`.
- **Target.** Remove `active:scale-[0.96]`. These are `w-full` or menu triggers, so the motion.css brightness press applies.

#### 1.8 Hover-hide classes are untokenised (F, LOW)

- **Files.** `lib/kit/sidebarRowStyles.ts:91-98`, `views/Sidebar.tsx:89,91,329,593`.
- **Target.** Replace bare `transition-opacity` with `transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)]`.

#### 1.9 Offcanvas literals (F, LOW)

- **Files.** `components/kit/sidebar.tsx:40-50,45`, `kit.css:187-198`.
- **Target.**
  - Use `var(--ease-drawer)` instead of the `cubic-bezier(0.32,0.72,0,1)` literal.
  - Make the card radius transition match the panel: 260 ms open, 200 ms close.
  - Drop the permanent `will-change-[translate]`; the transition promotes on its own.
  - Add `motion-reduce:transition-none` to the radius transition in the `kit.css` card rule.
- Leave the width/translate mechanism alone: it is the sidebar's established layout (rejected R12).

#### 1.10 Archive or remove a sidebar row (N, tens/day, M)

- **Files.** `views/Sidebar.tsx:856,898` (archive) and `:639` (remove project).
- **Trigger.** Pointer Archive button or menu.
- **Motion.**
  - Row leave: `usePresence` is not usable here, because the store removes the row. Instead:
    1. On click, set `data-leaving` on the row element and wrap it in `.t-appear` with `data-from="scale"`, giving opacity 0 and `scale(0.97)` over 150 ms with `--ease-exit`.
    2. After 150 ms, call `flip.capture()` and run the archive action.
    3. `useFlipList` slides the rows below into place: 250 ms translate with `--ease-smooth-out`.
  - Put the flip container on the project's thread list. Give each row `data-flip-key={thread.id}`.
  - Keyboard archive is instant.
- **Interruptible.** A click on a leaving row is ignored (`pointer-events: none`).
- **Reduced motion.** No delay, no flip; opacity only via the `t-appear` reduce rule.
- **Perf.** Transform only, at most 40 visible rows.
- **Accept.** Watched at 10%: the row fades and shrinks, then the rows below glide up with no jump.

#### 1.11 Pin and unpin (N, tens/day, M)

- **Files.** `views/Sidebar.tsx:838,845,874,830-834`.
- **Motion.**
  - The toolbar Pin ↔ PinFilled icon becomes `IconSwap tempo="quick"`.
  - The resting pin glyph slot gets a `t-pop` on mount and `t-pop-out` on removal (`usePresence`).
  - The row's re-sort uses `flip.capture()` before the update, so the row slides to its new slot.
- **Accept.** Pinning shows the icon morph and the row glides; nothing teleports.

#### 1.12 Sidebar status glyph (N, 100+ passive, M)

- **Files.** `views/Sidebar.tsx:694-713,830`.
- **Today.** The spinner, amber dot, red dot, clock, unread dot and empty state hard-swap.
- **Motion.**
  - Wrap the glyph slot in a keyed swap. Use `IconSwap tempo="quick"` when going between two glyphs.
  - When a glyph appears from nothing, give it `t-pop`. When it disappears, `t-pop-out` via `usePresence`.
  - Keep the stepped running spinner exactly as it is (deliberate WebKit backdrop cost).
- **Gate.** The glyph changes passively and the user does not repeat an action; 150 ms with no travel is below the frequency limit.
- **Perf.** One transform per changed row; nothing at idle.
- **Accept.** When a turn finishes, the spinner morphs into the unread dot in 150 ms.

#### 1.13 "Show N more" / "Show less" (N, occ, M)

- **Files.** `views/Sidebar.tsx:655-664`.
- **Motion.**
  - Revealed rows get `t-row-enter` with `style={{ animationDelay: \`${Math.min(i, 7) * 20}ms\` }}`.
  - Collapsing rows get `t-pop-out` (150 ms) before unmount, using `usePresence` on the extra-rows group.
  - The label becomes `TextSwap`.
- **Accept.** The cascade finishes within 400 ms.

#### 1.14 Subagent children expand (N, tens/day, M)

- **Files.** `views/Sidebar.tsx:651-653`, `views/subagents/SubagentSidebarRow.tsx:102-113`.
- **Motion.** Wrap the nested children in `DisclosureRegion` (`components/kit/DisclosureRegion.tsx`), the same as project rows.

#### 1.15 Rail Tasks review badge (N, occ, M)

- **Files.** `views/NavRail.tsx:113`.
- **Motion.** `t-pop` on mount. On removal, `usePresence(badge, 150)` plus `t-pop-out`.

#### 1.16 Rail usage (N, occ, M)

- **Files.** `views/RailUsage.tsx:39,156`, `kybern.css:829-844`.
- **Motion.**
  - The ring group pops in once limits load. If `!isLaunching()`, start the arcs at the full dash offset, then set the real value on the next frame. The existing 400 ms `--ease-out` dashoffset transition fills the ring.
  - The caption "Updating…" ↔ "Updated x ago" becomes `TextSwap`.
  - `.rail-usage-ring` opacity changes from `var(--duration-fast,150ms) ease` to `var(--duration-fast) var(--ease-out)`, and is added to the reduce block in `kybern.css:552-565`.
- **Accept.** At launch the rings are settled. After a refresh that changes limits, the arcs move.

#### 1.17 Rail update button (N, rare, M)

- **Files.** `views/AppUpdate.tsx:184`.
- **Motion.** `t-pop`, which already uses `--ease-bounce`; this is the rare delight budget. The Spinner ↔ Download icon becomes `IconSwap`.

#### 1.18 Pending pill and draft pencils (N, tens passive, M)

- **Files.** `views/Sidebar.tsx:222,599,815,820`.
- **Motion.** They already enter with `t-pop` (pending). Add exits through `usePresence` + `t-pop-out`. The pencils get `t-pop` on mount.

#### 1.19 Split view open/close (N, occ, M)

- **Files.** `views/SplitThreads.tsx:76-93,349`, `App.tsx:264-267`.
- **Motion.**
  - A newly created pane root gets `t-appear` with `data-from="scale"` and `data-blur="off"` (it holds a transcript): opacity plus `scale(0.97)` → 1 over 250 ms.
  - Closing: the closing pane leaves at 150 ms, then the sibling snaps to full width. Do not animate `flexBasis`.
  - Keyboard (⌘\ / ⌘⇧\) is instant.
- **Perf.** The pane scale is a single compositor layer; check `real-session` for leftover layers after it settles.

#### 1.20 Environment switcher status (N, occ, M)

- **Files.** `views/EnvironmentSwitcher.tsx:124-158`.
- **Motion.**
  - `DelayedSpinner` (`components/kybern/bits.tsx`, owned by package 2) is consumed as-is, wrapped here in `<span className="t-delayed-in" style={{"--delay":"0ms"}}>`.
  - The status dot gets `transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]`.
  - The name and status text become `TextSwap`.

#### 1.21 Environment dialog modes (N, rare, M)

- **Files.** `views/EnvironmentSwitcher.tsx:200-214,266-282`.
- **Motion.** Key the mode content and add `t-section-enter`, the existing class (`motion.css:449`, currently unused). Bootstrap step glyphs Spinner → Check become `IconSwap`.

#### 1.22 WorktreeCleanup exit (F, LOW)

- **Files.** `views/WorktreeCleanup.tsx:19`.
- **Target.** Key on `threadId` only while it is open: keep the last `threadId` in a ref during close, so the dialog's ending style runs.

#### 1.23 SessionsDialog is always instant (F, MED, M)

- **Files.** `views/SessionsDialog.tsx:50`.
- **Target.** `instant={!lastInputWasPointer()}`, captured on open. Keep `{open && <SessionPicker>}` mounted through the 150 ms exit: render it while `open || leaving` with `usePresence(open, 150)`.

#### 1.24 AppUpdate / GpuixPrompt copy (N, rare, M)

- **Files.** `views/GpuixPrompt.tsx:50-51`, `views/AppUpdate.tsx:152-167,186-193`.
- **Motion.** Copy → Copied becomes `IconSwap` + `TextSwap`. Progress labels become `TextSwap`.

#### 1.25 Toaster position flip (F, LOW)

- **Files.** `views/AppUpdate.tsx:373`.
- **Target.** Keep `position="bottom-right"` while the announcement is open, and offset the announcement instead. Report back if the overlap is unacceptable, rather than changing the layout.

#### 1.26 Handoff (N, rare, M)

- **Files.** `views/Handoff.tsx:67`.
- **Motion.** Spinner ↔ Arrow becomes `IconSwap tempo="quick"`. The hover arrow uses tokens.

#### 1.27 Leading controls on Notes (N, tens, M)

- **Files.** `views/chrome.tsx:141-143`.
- **Today.** `panelless → return null`, so the toggle and arrows vanish while the panel slides.
- **Motion.** `usePresence(!panelless, 150)` plus `t-appear` (`data-blur="off"`).

#### 1.28 Settings exit literal (F, LOW)

- **Files.** `App.tsx:325-334`.
- **Target.** Keep the `[0.4,0,1,1]` values, and add a comment that they equal `--ease-exit`. Framer cannot read CSS variables.

#### 1.29 Tray chips (N, tens, M)

- **Files.** `views/trayChips.tsx:75-76,122,180-181`.
- **Motion.** Chip labels (Checkout ↔ New worktree, branch name, One run ↔ Separate) become `TextSwap`. In the branch menu, "Loading branches…" → list gets `t-section-enter` on the list.

#### 1.30 `useResize` writes on every pointermove (F, MED)

- **Files.** `lib/hooks.ts:201-205`.
- **Target.** Coalesce `setWidth` to one call per animation frame (`requestAnimationFrame`, keep the latest value). Do not change the end value.

### Package 2 — composer, transcript, panels, delegations, subagents

**Owns:**
- `views/Composer.tsx`, `components/kit/chat/*`
- `components/kybern/ModelPicker.tsx`, `ModelPickerTabs.tsx`
- `views/Thread.tsx`, `views/Transcript.tsx`
- `components/beui/message-scroller.tsx`, `preview-rail.tsx`, `virtual-preview-rail.tsx`, `lib/beui/ease.ts`
- `components/kybern/Markdown.tsx`, `CodeBlock.tsx`, `MermaidBlock.tsx`, `ResponseImage.tsx`, `bits.tsx`
- `views/QuestionSteps.tsx`, `UserInputPanel.tsx`, `AsyncQuestionPanel.tsx`, `SecretRequestPanel.tsx`
- `views/VisualReply.tsx`, `views/Artifacts.tsx`
- `views/delegations/*`
- `views/subagents/*` except `SubagentSidebarRow.tsx`
- `views/coordinator/*`, `views/ComputerLiveView.tsx`, `views/Activity.tsx`
- `styles/subagents.css` and the kit.css/kybern.css blocks above

**Hot path.** Read `perf/README.md` first. Do not touch `VirtualRows.tsx`.

**Items:** 43.

**Native checks:**
- `node scripts/check-rendering.mjs` (streaming)
- `work-stream`
- `composer-stack`
- `questions`
- `interaction`
- `scrolling`
- `visuals-bounce`
- `artifacts`
- `chat-fixes`
- `orchestrator`

#### 2.1 Live → settled turn (N, 100+ passive, M)

- **Files.** `views/Transcript.tsx:758-772` vs `:774-888`, plus `:946-955` (WorkingHeader), `:821` (hairline) and `:879-885` (footer).
- **Today.** Measured: the settle commit starts 0 animations other than leftover stream words (`probe-s4-dark.txt` `settle`). The working header, hairline and footer swap in one commit.
- **Motion.** Animate only the new chrome. Never the answer body: it already streamed in, and its identity must stay stable.
  1. The header label "Working for 12s" → "Worked for 14s": render both through one `TextSwap` in the same slot, if the live and settled headers can share a slot. If the trees differ, give the settled header `t-appear` with `data-blur="off"`.
  2. Hairline: `transform-origin: left; animation: t-bar-grow var(--duration-fast) var(--ease-smooth-out) backwards`. Define `@keyframes t-bar-grow { from { transform: scaleX(0) } }` locally in the `kit.css` `.chat-*` block.
  3. Footer actions and time: `t-appear` with `data-blur="off"`.
  - All three only when the turn settled less than 3 s ago (the existing `fresh` rule). History and remounts render settled.
- **Reduced motion.** Opacity only.
- **Perf.** Three small elements per settle. Verify `work-stream` and `interaction` keep row identities: no remount of settled turns, and 12/12 retained turn groups as in the glass-transcript report.
- **Accept.** In the probe's `settle` window: one TextSwap pair or `t-appear`, one `t-bar-grow`, one `t-appear`, each ≤ 250 ms.

#### 2.2 Error / Stopped / Reverted lines (N, occ, M)

- **Files.** `Transcript.tsx:853-877`.
- **Motion.** `t-row-enter` when fresh.

#### 2.3 Composer-stack panel entrance is a bare fade (F, MED, M)

- **Files.** `kit.css:2780-2818` (`.composer-panel-stack .t-panel-enter` → `composer-panel-enter`).
- **Today.** Measured: `composer-panel-enter` 350 ms opacity only, for approvals and questions.
- **Target.** Change the keyframe `from` to `{ opacity: 0; transform: translateY(var(--distance-small)); }`, with duration `var(--duration-fast)`. No blur: it sits inside the composer glass.

#### 2.4 Panels leave on resolve (N, tens, M)

- **Files.**
  - `views/Thread.tsx:501-507,740,761,863,891` (approvals)
  - `QuestionSteps.tsx`, `UserInputPanel.tsx`, `SecretRequestPanel.tsx`
  - `coordinator/CoordinatorCards.tsx:97,154,231`
- **Today.** The resolved card unmounts instantly. The success shows only on the transcript row.
- **Motion.** Keep the last resolved card mounted for 150 ms with `usePresence`, with `data-leaving` styles `opacity: 0; transform: translateY(var(--distance-micro))` and `--ease-exit`. Use a local class in the `.composer-*` block. Then let the stack height snap (rejected R7).
- **Keyboard.** Digits 1–4 are a keyboard action, but the response itself is instant. The 150 ms exit runs after the decision has been sent and does not delay it.
- **Accept.**
  - The approve RPC fires on click, with no delay.
  - The card fades down over 150 ms.
  - A second approval arriving during the exit replaces the leaving one immediately.

#### 2.5 Send ↔ stop button (N, 100+ passive, M)

- **Files.** `views/Composer.tsx:1403-1463`.
- **Motion.** Render the send and stop glyphs in one `IconSwap tempo="quick"` slot inside one button, if the two buttons can share an element. Otherwise wrap the two in a `.t-icon-swap` cell. Tooltip text: `TextSwap`.

#### 2.6 Send spinner (F, LOW)

- **Files.** `Composer.tsx:1446`.
- **Target.** Use `Spinner` from `components/kybern/bits.tsx` (stepped), not `animate-spin`. It sits on the composer glass, where smooth rotation forces backdrop work.

#### 2.7 Queue/steer chip group (N, tens, M)

- **Files.** `Composer.tsx:1364-1402,1383`.
- **Motion.** `t-appear` with `data-blur="off"` when `running` flips, plus an exit via `usePresence`. The label becomes `TextSwap`.

#### 2.8 Slash/mention active row lags on arrow keys (F, MED, M)

- **Files.** `components/kit/chat/composerPickerStyles.ts:234`.
- **Target.** Remove `transition-colors duration-100` from the highlighted-row class. Keyboard highlight must be instant. Keep the menu itself instant (rejected R3).

#### 2.9 Attachment chip remove (N, occ, M)

- **Files.** `Composer.tsx:1147-1161`.
- **Motion.** `RemoveButton` marks the chip leaving (`t-pop-out`, 150 ms), then removes it.

#### 2.10 Uploading row (N, occ, M)

- **Files.** `Composer.tsx:1165-1168`.
- **Motion.** `t-appear` with `data-blur="off"`, plus `usePresence`.

#### 2.11 Model picker exit shows an empty box (F, HIGH)

- **Files.** `components/kybern/ModelPicker.tsx:129-132`.
- **Today.** `{open && <ModelPickerPanel …/>}` unmounts the content when `open` turns false, so the 150 ms popup exit animates an empty shell.
- **Target.** Render the panel while `open || leaving` (`usePresence(open, 150)`), or rely on Base UI `keepMounted` on the popup.
- **Accept.** At 10% speed, the exit shows the real list shrinking and fading.

#### 2.12 Model picker tabs (N, tens, M)

- **Files.** `ModelPickerTabs.tsx:19-21`.
- **Motion.** `useSlidingPill` + `.t-tabs`/`.t-tabs-pill`. Copy `views/pullRequests/PrTabs.tsx:33-84`. Mark the active tab with `data-tab-active`.

#### 2.13 Model star (N, occ, M)

- **Files.** `ModelPicker.tsx:980-986`.
- **Motion.** Star ↔ filled star becomes `IconSwap tempo="quick"`. On becoming a favourite, add `t-pop` once (light element, so the bounce is allowed). ⌘D is instant: no pop.

#### 2.14 "Loading thread" loader never shows (F, HIGH)

- **Files.** `views/Transcript.tsx:444`.
- **Today.** It uses `opacity-0 [animation:chat-mount-loader-in_200ms_ease-out_150ms_forwards]`, but no `@keyframes chat-mount-loader-in` exists anywhere. The loader stays invisible, and the `forwards` fill breaks the perf rule.
- **Target.** `className="t-delayed-in"` with `style={{ "--delay": "150ms" }}`. Drop `opacity-0` and the arbitrary animation.
- **Accept.** On a cold thread open slower than 150 ms, the matrix loader fades in. On a fast open it never shows.

#### 2.15 Scroll-to-bottom button (F, MED, M)

- **Files.** `Transcript.tsx:538-555`.
- **Today.** Always mounted at `opacity-0 blur-[2px]`, with a `backdrop-blur-md` button: the idle-layer pattern the perf guide forbids. Its hidden state is `-translate-y-1`, so it drops down to appear.
- **Target.**
  - Mount only while shown: `usePresence(show, 150)`.
  - Enter with a 4 px rise from below: `translate-y-1` → 0, opacity, 250 ms `--ease-smooth-out`.
  - Exit quick with `--ease-exit`.
  - Keep the backdrop blur, but only while mounted.
- **Accept.** `real-session` idle assertions pass, and there is no idle backdrop layer at the bottom of an idle thread.

#### 2.16 Bubble hover actions and time (F, LOW, M)

- **Files.** `Transcript.tsx:109-110` (`HOVER_REVEAL`).
- **Target.** `transition-[opacity,transform] duration-[var(--duration-quick)] ease-[var(--ease-out)]`, plus `translate-y-0.5` → 0 on reveal. Hover only; gate the translate behind `@media (hover: hover) and (pointer: fine)` in the class (Tailwind `pointer-fine:`) if available. Otherwise opacity only.

#### 2.17 Tool row status (N, 100+ passive, M)

- **Files.** `Transcript.tsx:1634-1660`.
- **Motion.** The verb label ("Running" → "Ran", "Reading" → "Read") goes through `TextSwap`, keyed on the label. The shimmer stops when the label swaps.
- **Perf.** TextSwap keeps both labels only for 220 ms. Check `work-stream` for row-height stability: the labels share a grid cell, so the height is unchanged.

#### 2.18 Approval row resolves (N, tens, M)

- **Files.** `Transcript.tsx:1540-1556`.
- **Motion.** `approvalRowText` becomes `TextSwap`. The tone colour gets `transition-colors duration-[var(--duration-fast)]`.

#### 2.19 Notice rows (N, occ, M)

- **Files.** `Transcript.tsx:1561-1573`.
- **Motion.** `t-row-enter` when fresh, as `ToolRow` does at `:1634`.

#### 2.20 Edited files card (N, tens, M)

- **Files.** `Transcript.tsx:871,1823`.
- **Motion.** `t-appear` with `data-blur="off"`, when it mounts for a fresh turn.

#### 2.21 Copy timers (F, LOW)

- **Files.** `Transcript.tsx:971`, `CodeBlock.tsx:139`, `bits.tsx:52`.
- **Target.** Store the 1400 ms timeout in a ref and clear it on unmount. Copy `ResponseImage.tsx:101-105`.

#### 2.22 ResponseImage (F, MED, M)

- **Files.** `ResponseImage.tsx:248,285`.
- **Target.** Reset `loaded=false` when `url` changes. Give the lightbox's original `<img>` `className="t-img"` with `data-loaded` driven by `onLoad`.

#### 2.23 Lightbox opens from the thumbnail (N, occ, M)

- **Files.** `ResponseImage.tsx:250-287`.
- **Motion.**
  - On open, read the thumbnail's `getBoundingClientRect()` and the dialog image's final rect after mount.
  - Animate the dialog image with WAAPI from `transform: translate(dx,dy) scale(s)` to `none`: 300 ms `cubic-bezier(0.32, 0.72, 0, 1)` (`--ease-drawer`).
  - The backdrop keeps its own fade.
  - Close: reverse at 200 ms with `cubic-bezier(0.4, 0, 1, 1)`, back to the thumbnail rect if it is still on screen; otherwise use the dialog's default exit.
  - Modals are exempt from trigger origin, but this is a deliberate shared-element zoom for images only.
- **Reduced motion.** Default dialog fade.
- **Accept.** The image visibly grows out of its thumbnail. Interrupting (Escape mid-open) reverses from the current transform: cancel and read the computed transform, as `navMotion.ts` does.

#### 2.24 Visual reply expand/collapse (N, occ, M)

- **Files.** `views/VisualReply.tsx:175-192`, `kit.css:3494`.
- **Motion.** Same FLIP as 2.23, from the card rect to the expanded rect, at 300 ms with `--ease-drawer`. The backdrop gets an opacity transition at 250 ms. Do not move the iframe in the DOM: animate the wrapper's transform only.

#### 2.25 Question step change (N, occ, M)

- **Files.** `QuestionSteps.tsx:48`.
- **Motion.** The keyed fieldset gets `t-section-enter`, with direction: add `style={{ "--dir": forward ? 1 : -1 }}` and a local variant `translateX(calc(var(--dir) * 8px))` in the `.question-panel-*` block. Counts and hints become `TextSwap`.

#### 2.26 Question footer buttons lose their hover colour (F, LOW)

- **Files.** `kybern.css:974`.
- **Target.** `transition: scale var(--duration-micro) var(--ease-out), background-color var(--duration-quick) var(--ease-out), color var(--duration-quick) var(--ease-out), border-color var(--duration-quick) var(--ease-out);`.

#### 2.27 Queued row (N, occ, M)

- **Files.** `Thread.tsx:653-691`.
- **Motion.** Removal: `t-pop-out`, 150 ms. `showBody` uses `DisclosureRegion`. Edit ↔ textarea stays instant (typing context).

#### 2.28 Persistent `will-change` on fresh bubbles (F, MED)

- **Files.** `kit.css:351-353`.
- **Target.** Remove `will-change: opacity, transform, filter` from `.chat-message-send-enter`. Use the `backwards` fill, as `.sidebar-surface-enter` does at `kit.css:310-333`.

#### 2.29 Environment inset animates `padding-right` across the transcript (F, HIGH, M)

- **Files.** `components/kit/chat/composerPickerStyles.ts:215,219`, applied at `views/Thread.tsx:426,436`.
- **Today.** A 300 ms `padding-right` transition on the whole transcript container re-lays out every frame on the hot path.
- **Target.** Remove the padding transition: the inset snaps. The environment card keeps its own `translate-x-full` slide (`Environment.tsx`, package 3).
- **Accept.**
  - Toggling the environment panel shows no `padding-*` transition.
  - Frame intervals during the toggle stay under 16.7 ms p95 with the 400-turn fixture (`scaling`).

#### 2.30 Message rail (N, occ, M)

- **Files.** `components/beui/message-scroller.tsx:685-687`, `preview-rail.tsx:201-204`, `virtual-preview-rail.tsx:113-119`.
- **Motion.**
  - Rail container: `transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)]`.
  - New tick, fresh message only: Framer `initial={{ scaleX: 0.4, opacity: 0 }}` on ticks created after mount. Use `initial={false}` for the first render.
  - Virtual rail preview: wrap it in `AnimatePresence`, with the same values as `preview-rail.tsx:348-382`.

#### 2.31 Beui ease constant (F, LOW)

- **Files.** `lib/beui/ease.ts`.
- **Target.** `EASE_OUT = [0.23, 1, 0.32, 1]` (`--ease-out`).

#### 2.32 Held messages (N, occ, M)

- **Files.** `delegations/HeldMessagesPanel.tsx:46,53`.
- **Motion.** The row leaves with `t-pop-out` on deliver or dismiss.

#### 2.33 Subagent strip hover swap (F, LOW, M)

- **Files.** `subagents/SubagentStrip.tsx:163-170`.
- **Target.** The actions use `t-reveal`. The time fades out with a matching `translateX(-4px)`.

#### 2.34 Subagent page status text (N, tens, M)

- **Files.** `subagents/SubagentPage.tsx:235-241,262-296`.
- **Motion.** "Working ⟨time⟩" ↔ label becomes `TextSwap`. The working ↔ settled button sets get `t-appear` with `data-blur="off"`.

#### 2.35 Coordinator outcome icon (N, occ, M)

- **Files.** `coordinator/CoordinatorRows.tsx:53`.
- **Motion.** `IconSwap`.

#### 2.36 ComputerLiveView (F, LOW)

- **Files.** `ComputerLiveView.tsx:22`, `kybern.css:306-307`.
- **Target.**
  - `EXIT_MS = 160`, to match the CSS.
  - Size toggle: replace the `width/height` transition with an instant size change plus a `scale` FLIP of the card, 200 ms `--ease-smooth-out`.
  - If the frame image distorts during the scale, keep the width transition and report back.

#### 2.37 Activity glyph (N, occ, M)

- **Files.** `views/Activity.tsx:116-136`.
- **Motion.** `IconSwap` for check ↔ spinner and for action icon ↔ spinner.

#### 2.38 Mermaid (N, rare, M)

- **Files.** `MermaidBlock.tsx:37-39`.
- **Motion.** The diagram `<img>` gets `t-img` with `data-loaded`. Preview and source become a `t-pane` pair, as `VisualPreviewPanel.tsx:108-113` does.

#### 2.39 "Sending…" labels (N, rare, M)

- **Files.** `Artifacts.tsx:301-305`, `subagents/NativeSubagentComposer.tsx:81-88`, `delegations/ThreadMessageRows.tsx:315`.
- **Motion.** `TextSwap`. The status icon becomes `IconSwap`.

#### 2.40 Live caret on blocks (F, LOW, M)

- **Files.** `motion.css:547-563` (selector owned by package 0, change requested from package 2; apply it in package 0 if it lands first).
- **Today.** The probe recorded `t-caret-blink` on `div.chat-markdown-table::after` and `div.chat-markdown-codeblock::after`.
- **Target.** Restrict the selector with `:last-child:is(p, li, h1, h2, h3, h4, h5, h6, blockquote)::after`.
- **Feel-check.** Stream a table, then a code block: no bar after either.

#### 2.41 Text shows in the composer and the bubble at once (F, MED, M)

- **Files.** `Composer.tsx:742-756`.
- **Today.** The editor clears only after the RPC resolves, while the bubble enters on the server echo.
- **Target.** Snapshot the draft, clear the editor and attachments synchronously when Send is accepted, and restore the snapshot if the RPC fails. That is behaviour, not new motion, and it removes the double-exposure.
- **Accept.** Over a 300 ms artificial RPC delay, the text appears only in the bubble.

#### 2.42 Ultrathink loops (F, MED)

- **Files.** `kit.css:3207-3272`.
- **Target.**
  - Add the classes to the reduce block: `animation: none`.
  - Pause with `[data-loop-paused]` through `observeLoopVisibility` on the host element. Find the element that renders them in `Composer.tsx` or `components/kit/chat/ComposerEditor.tsx`.

#### 2.43 Delegation badges (N, occ, M)

- **Files.** `delegations/DelegationRows.tsx:187-201`.
- **Motion.** The conflict badge gets `t-pop`. Override text gets `t-appear`.

### Package 3 — right dock, explorer, terminal, preview, lineage

**Owns:**
- `views/RightPanel.tsx`, `views/dock/**` (including `preview/*`), `state/previewSurface.ts`
- `views/Explorer.tsx`, `components/beui/file-tree.tsx`, `components/beui/shared-layout-bg.tsx`
- `views/Terminal.tsx`, `components/kybern/DiffView.tsx`
- `views/lineage/**` (including `parts.tsx`: `ChildGlyph` also serves delegation rows)
- `views/Environment.tsx`
- `components/kybern/ResizeHandle.tsx`, `components/kybern/chatPaneDrag.ts`, `ChatPaneDropOverlay.tsx`
- The kit.css `.preview-*` block and the kybern.css drag/drop block

**Constraints.**
- Never move a preview iframe in the DOM.
- Never use `visibility: hidden` on panes.
- No blur or scale on the terminal canvas.

**Items:** 31.

**Native checks:**
- `KYBERN_PERF_FOREGROUND=1 node scripts/check-rendering.mjs preview`
- `orchestrator`
- `chat-coordinator`
- `tool-memory`
- `interaction`

#### 3.1 Hidden panes are not inert (F, MED, M)

- **Files.** `RightPanel.tsx:155-192`.
- **Target.** Add `inert={!active || undefined}` next to `aria-hidden` on each `t-pane` wrapper. This is accessibility, found during the walk; it is not a motion change.

#### 3.2 Dock tab add/close (N, occ, M)

- **Files.** `RightPanel.tsx:84-104,203-208`.
- **Motion.**
  - A new tab chip gets `t-appear` with `data-from="scale"`.
  - Closing: `flip.capture()` on the tab strip before removal (items `data-flip-key={tab.id}`). The closing chip is gone at once and the siblings slide left 250 ms.
  - Keyboard close is instant.

#### 3.3 Preview-unseen dot (N, occ, M)

- **Files.** `RightPanel.tsx:118`.
- **Motion.** `t-pop`, matching the other badges.

#### 3.4 Changes pane states (N, tens, M)

- **Files.** `RightPanel.tsx:276-340`.
- **Motion.**
  - Busy icon ↔ `Spinner`: `IconSwap tempo="quick"`.
  - Ahead/behind (`:276-282`) and the dirty count (`:291`): `TextSwap`.
  - Summary `DiffStat` (`:326`): `t-pop`, keyed on adds:dels, the same as the tab badge.
  - Create PR ↔ "#N" (`:305-309`): `TextSwap`.
  - "Show N more" cards: `t-row-enter` with a 20 ms cascade, capped at 8.

#### 3.5 Dock empty states (N, occ, M)

- **Files.** `RightPanel.tsx:152,162`, `dock/DockParts.tsx:45-59`.
- **Motion.** `t-stagger` with `data-tempo="quick"`. Only on first show, not on pane switch: the `useShownOnce` gate (`DockParts.tsx:60-64`) already marks this.

#### 3.6 Tasks dock (N, tens, M)

- **Files.** `dock/TasksDockPanel.tsx:56-84,135-139`.
- **Motion.**
  - Rows created under 3 s ago get `t-row-enter`.
  - Removed rows: `t-pop-out` via a local presence map, or simply none if that gets complex. Report which.
  - Checklist ring: `transition: stroke-dashoffset var(--duration-slow) var(--ease-out)`.
  - Run-card activity text: `TextSwap`.
  - Loading: replace the `null` with the kit `Skeleton` wrapped in `t-delayed-in` (`--delay: 300ms`).

#### 3.7 Notes dock (N, occ, M)

- **Files.** `dock/NotesDockPanel.tsx:83-116`.
- **Motion.** Rows updated under 3 s ago get `t-row-enter`. "Open in Notes" gets `t-appear`.

#### 3.8 Project dock editor (N, occ, M)

- **Files.** `dock/ProjectDockPanel.tsx:106-145`.
- **Motion.** The Edit/Done/Write label becomes `TextSwap`. The editor ↔ clamped text gets `t-section-enter`, keyed on mode.

#### 3.9 Preview chrome (N, tens, M)

- **Files.** `dock/preview/PreviewChromeRow.tsx:142-145,241`, `WebPreviewPanel.tsx:52-53`.
- **Motion.**
  - Site icon: `IconSwap tempo="quick"`.
  - "Open in browser" reveal: `t-reveal` with hidden state `opacity-0 translate-x-1`.
  - Device toolbar and notice strips: `t-appear` with `data-from="above"` and `data-blur="off"`.
  - The strip pushes the iframe down once. That single resize is acceptable; do not animate the push.

#### 3.10 Preview states (N, occ, M)

- **Files.** `dock/preview/PreviewStates.tsx:24-35,98-106,212-236,249-274`.
- **Motion.**
  - `StateShell` and `PermissionCard`: `t-section-enter`.
  - "Waiting…" / "Stopped waiting." and "Try now" / "Try again": `TextSwap`.
  - Notice strips: as in 3.9.

#### 3.11 Preview server rows have no press feedback (F, LOW)

- **Files.** `dock/preview/PreviewEmptyState.tsx:43,187`.
- **Target.** Use `press-row`, or `data-press="row"`, instead of `press` on these `w-full` rows. The remove reveal uses tokens.

#### 3.12 Mini-player exit origin (F, MED, M)

- **Files.** `kit.css:3743-3756`, `PreviewMiniPlayer.tsx:212-268`.
- **Today.** `--pip-origin` is never set, so the exit always shrinks toward the bottom-right.
- **Target.** Set `--pip-origin` on the player element from its snapped corner: `top left`, `top right`, `bottom left` or `bottom right`. Update it on every snap.

#### 3.13 Mini-player enter (N, rare, M)

- **Files.** `PreviewMiniPlayer.tsx`, `state/previewSurface.ts:206-212`.
- **Motion.**
  - Floating switches the surface from the dock rect to the pip rect.
  - Animate the surface **container's** transform from the dock rect to rest using WAAPI: `translate(dx,dy) scale(sx,sy)` → `none`, 300 ms, `cubic-bezier(0.32, 0.72, 0, 1)`.
  - The iframe stays in place in the DOM; only the wrapper transform moves.
  - Return to the panel: the reverse, 220 ms, `--ease-exit` values `cubic-bezier(0.4, 0, 1, 1)`.
- **Reduced motion.** The existing fade path (`:202-210`).
- **Accept.** The page flies to the corner without a reload. `preview` fixture screenshots match.

#### 3.14 Preview surface fade out of step with the pane (F, LOW)

- **Files.** `kit.css:3636-3651`.
- **Target.** Show transition `var(--duration-fast) var(--ease-smooth-out)`. Hide transition `var(--duration-quick) var(--ease-exit)`.

#### 3.15 Explorer copy gives no feedback (F, occ, M)

- **Files.** `Explorer.tsx:342-350`.
- **Target.** Copy icon → Check through `IconSwap` for 1400 ms, with a cleared timer.

#### 3.16 File tree first load and search-clear replay the stagger (F, MED, M)

- **Files.** `components/beui/file-tree.tsx:399-414`, `Explorer.tsx:170-204`.
- **Target.** Pass `initial={false}` on the first commit of a mounted tree, and on the remount after the search is cleared. Rows that appear later (folder expanded) keep their entrance.

#### 3.17 File tree collapse (N, tens, M)

- **Files.** `file-tree.tsx:399-455`.
- **Motion.**
  - Wrap child rows in `AnimatePresence`. Exit: `{ opacity: 0, y: -4, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] } }`.
  - The branch line's existing `exit` then runs.
  - Keep the existing gates: off above 150 rows, when windowed, and under reduced motion.

#### 3.18 Hover pill spawns one blur wrapper per row (F, MED)

- **Files.** `components/beui/shared-layout-bg.tsx:37-42,88-114`.
- **Target.** Mount the animated pill only in the hovered row: render the wrapper only when `hoveredId === id`. Keep the `layoutId` morph.
- **Accept.** Hovering into the tree starts one blur/opacity animation, not one per row.

#### 3.19 File viewer open (N, tens, M)

- **Files.** `Explorer.tsx:209,368-399`.
- **Motion.**
  - Pointer-opened files: the content root gets `t-section-enter`, keyed by path.
  - Enter or arrow-key opens are instant (`lastInputWasPointer`).
  - The skeleton gets `t-delayed-in` with `--delay: 200ms`, so fast files never flash a skeleton.

#### 3.20 Markdown Source/Preview toggle (N, occ, M)

- **Files.** `Explorer.tsx:303-329`.
- **Motion.** Replace it with `components/kit/segmented-control.tsx`, which already has the sliding pill, or add `useSlidingPill` with the same markup.

#### 3.21 Terminal tab pane (F, LOW, M)

- **Files.** `Terminal.tsx:199`.
- **Target.** `transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none`. Opacity only, never transform or filter, because of the WebGL canvas.

#### 3.22 Terminal tab chips (N, occ, M)

- **Files.** `Terminal.tsx:117-133,209-229,325-332`.
- **Motion.**
  - New chip: `t-appear` with `data-from="scale"`.
  - Closing chip: `t-pop-out`, then removal.
  - On process exit, the existing 600 ms wait ends with the same `t-pop-out` instead of vanishing.

#### 3.23 Terminal chip icon ↔ close (N, tens, M)

- **Files.** `Terminal.tsx:221-224`.
- **Motion.** `t-icon-swap` markup with `data-active` driven by `:hover`/`:focus-within`, or `IconSwap tempo="quick"` driven by hover state.

#### 3.24 DiffView body (N, tens, M)

- **Files.** `components/kybern/DiffView.tsx:195-202`.
- **Motion.** Replace `{open && …}` with `DisclosureRegion`, matching the transcript's `EditedFileRow`.
- **Perf.** Limit to files under the existing large-diff threshold. Very large bodies open instantly. Check `tool-memory`.

#### 3.25 Lineage and delegation status glyph (N, tens passive, M)

- **Files.** `views/lineage/parts.tsx:23-41` (`ChildGlyph`).
- **Motion.** `IconSwap tempo="quick"` between the MatrixLoader orbit, hand, check, alert and stop. Keep `MatrixLoader` as the "a" node while running. This also fixes delegation rows (package 2 consumes `ChildGlyph` unchanged).

#### 3.26 Lineage hover actions (F, LOW, M)

- **Files.** `lineage/LineageRow.tsx:35,102-108`.
- **Target.** Actions use `t-reveal`. The elapsed timer fades out with `translateX(-4px)`. The action buttons get `press`.

#### 3.27 Lineage tree expand (N, tens, M)

- **Files.** `lineage/LineagePane.tsx`, `LineageRow.tsx:58-61`.
- **Motion.**
  - Child rows revealed by expanding get `t-row-enter` with a 20 ms cascade (`animationDelay`), capped at 8 rows.
  - Collapsing hides them instantly (inside `VirtualRows`, so no exit animation).
  - The summary and "Stop all" get `t-appear`.

#### 3.28 Environment card exit (F, LOW, M)

- **Files.** `composerPickerStyles.ts:214-215` (shared file, owned by package 2 — **request the change from package 2**), `Environment.tsx:221-231`.
- **Target.** Closed state: `duration-[var(--duration-quick)] ease-[var(--ease-exit)]`. Open stays at 300 ms with `--ease-drawer`.
- **Ownership note.** If package 2 owns `composerPickerStyles.ts`, apply the class at the `Environment.tsx` call site instead, through `cn(…)` overrides.

#### 3.29 Environment card sections (N, occ, M)

- **Files.** `Environment.tsx:254-373`.
- **Motion.** Sections toggled from the gear menu sit inside `DisclosureRegion`. Commit/PR spinners become `IconSwap`. The dirty count becomes `TextSwap`.

#### 3.30 Chat pane drag (N, occ, M)

- **Files.** `chatPaneDrag.ts:86,130-157`, `ChatPaneDropOverlay.tsx:33-43,144`, the kybern.css drag block.
- **Motion.**
  - **Pickup.** The preview clone animates `scale(1) → scale(1.02)` and shadow-layer opacity 0 → 1, at `--duration-micro` with `--ease-out`. Put the shadow on a `::before` opacity layer, not an animated `box-shadow`.
  - **Cancel.** The clone animates back to the source rect, 250 ms `--ease-drawer`, then is removed.
  - **Drop.** The clone fades out over 150 ms.
  - **Zone change.** Give the drop target a `transition: transform var(--duration-fast) var(--ease-smooth-out)`. Express the position classes as transforms where possible; otherwise accept the jump and report it.
- **Reduced motion.** No scale; instant removal.

#### 3.31 ResizeHandle line (F, LOW, M)

- **Files.** `components/kybern/ResizeHandle.tsx:53`.
- **Target.** `after:transition-colors after:duration-[var(--duration-quick)] after:ease-[var(--ease-out)] hover:after:delay-[120ms]`. The highlight only shows when the pointer rests on the handle, not when it passes over it.

### Package 4 — pages (Notes, Tasks, PRs, Usage, Settings) and kit overlays

**Owns:**
- `views/notes/**`, `styles/notes.css`
- `views/tasks/**`, `styles/tasks.css`
- `views/pullRequests/**`, `views/PrReview.tsx`, `views/pullRequests/review.css`
- `views/UsagePage.tsx`, `views/SettingsScreen.tsx`, `views/settings/**`, `styles/settings.css`
- `views/Integrations.tsx`, `components/kybern/accounts/AddAccountSheet.tsx`, `components/kybern/LimitMeter.tsx`
- `components/kit/*` except `command.tsx` and `chat/*`:
  - dialog, alert-dialog, sheet, menu, select, combobox, autocomplete
  - popover, tooltip, preview-card
  - switch, checkbox, toggle, segmented-control
  - skeleton, empty, collapsible, `DisclosureRegion`, `DisclosureChevron`, scroll-area
- `lib/kit/disclosureMotion.ts`
- `components/ui/*` (context-menu, sonner)
- The kit.css `--animate-skeleton` and `.account-*` blocks
- The kybern.css `.limit-meter*` block

**Items:** 40.

**Native checks:**
- `node scripts/check-rendering.mjs materials` (menus and popups)
- `settings`
- `prompts`
- `activity`
- `profiles`
- `node --experimental-strip-types scripts/check-window-material.mjs`

#### 4.1 Context menus never animate (F, HIGH, M)

- **Files.** `components/ui/context-menu.tsx:55`.
- **Today.** `data-open:animate-in fade-in-0 zoom-in-95 … data-closed:animate-out duration-100`. tw-animate-css is not installed (verified: 0 matches in `package.json` and the styles), so every right-click menu snaps open and shut.
- **Target.** Replace those classes with the popup recipe from `components/kit/menu.tsx:104`: scale 0.97 + 2 px blur + opacity, 250 ms `--ease-smooth-out`; exit 150 ms to scale 0.99; `origin-(--transform-origin)`; motion-reduce. Copy the class string exactly.
- **Accept.** Right-clicking a sidebar thread starts `opacity`/`scale`/`filter` transitions at 250 ms in and 150 ms out.

#### 4.2 Select popup has no motion (F, HIGH, M)

- **Files.** `components/kit/select.tsx:192`.
- **Target.** Add the same recipe as `menu.tsx:104`, with `data-starting-style:` and `data-ending-style:` variants. Keep `origin-(--transform-origin)`.

#### 4.3 Combobox and autocomplete popups (F, MED, M)

- **Files.** `combobox.tsx:177`, `autocomplete.tsx:115`.
- **Target.** Move `transition-[scale,opacity]` and the starting/ending styles from the wrapper `<span>`, which never receives `data-starting-style`, onto the Popup element.
- **Caution.** The palette's inline list is not a popup: leave `autocomplete.tsx:136` item highlights untouched.

#### 4.4 AlertDialog and Sheet (F, MED, M)

- **Files.** `alert-dialog.tsx:22,46`, `sheet.tsx:25,85-93`.
- **Target.**
  - Backdrops: `transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] data-ending-style:duration-[var(--duration-quick)]`. No `transition-all`.
  - Popups: copy `dialog.tsx:55` (scale 0.96 + blur in, 0.98 out, 250/150 ms, smooth-out). For Sheet use `translate` ±2rem in place of scale.
  - Add `motion-reduce:transition-none`.

#### 4.5 Preview card (F, LOW, M)

- **Files.** `preview-card.tsx:50`.
- **Target.** Use the popover recipe (`popover.tsx:64`) with tokens, plus `motion-reduce:transition-none`.

#### 4.6 Checkbox uncheck (F, LOW, M)

- **Files.** `checkbox.tsx:54`.
- **Target.** Replace `data-unchecked:hidden` with `data-unchecked:scale-80 data-unchecked:opacity-0` and the existing quick transition, so unchecking reverses.

#### 4.7 Switch (F, MED, M)

- **Files.** `switch.tsx:13,16`.
- **Today.** The thumb is `[transition:translate_.2s_ease-out,…]` and the track `duration-200`. Both still move under reduced motion (`probe-s5.txt`).
- **Target.**
  - Thumb: `translate var(--duration-fast) var(--ease-spring)`, keeping the existing press stretch.
  - Track colours: `var(--duration-quick) var(--ease-out)`.
  - Add `motion-reduce:transition-[background-color,border-color]` (the colour stays, the travel goes).

#### 4.8 Disclosure (F, MED, M)

- **Files.** `lib/kit/disclosureMotion.ts:14-36`, `components/kit/DisclosureRegion.tsx:25,39`.
- **Today.** 220 ms with the Tailwind `ease-out`, open and close equal. The inner content mounts already in its open classes, so the drift plays only on close.
- **Target.**
  - Open: `duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]`.
  - Close: `duration-[var(--duration-quick)] ease-[var(--ease-exit)]`.
  - Mount the content in the closed classes and flip to open on the next frame (`requestAnimationFrame`), so the -4 px → 0 drift plays on open.
  - Keep `grid-template-rows`: this is the documented accordion exception and is already used everywhere.
  - Unmount after 160 ms instead of 260 ms.
- **Perf.** Inside virtual rows, this triggers a measure per frame. Run `work-stream` and `interaction` and confirm there are no scroll jumps.

#### 4.9 Skeleton and pulse (F, MED)

- **Files.** `skeleton.tsx:7`, `kit.css:6,70`, `Integrations.tsx:293-300`.
- **Target.** Add a reduce rule for `animate-skeleton` (`animation: none`, static highlight). Package 0 adds the pause rule. Replace `animate-pulse` in Integrations with the kit `Skeleton`.

#### 4.10 Positioner transitions under reduced motion (F, LOW)

- **Files.** `tooltip.tsx:73`, `popover.tsx:56`.
- **Target.** Add `motion-reduce:transition-none` to the positioners. Keep the top/left follow between triggers: it is the shared-popover behaviour of the rail usage cards.

#### 4.11 Notes gallery → editor (N, tens, M)

- **Files.** `views/notes/NotesGallery.tsx`, `NoteEditor.tsx:297,311`, `notes.css:783-791`.
- **Motion.**
  - On a pointer open, store the clicked card's centre relative to the viewport. Set it as `--note-origin-x` / `--note-origin-y` on the editor root.
  - Change `.notes-enter .note-doc` to animate `opacity 0 → 1` and `transform: scale(0.97) → none`, with `transform-origin: var(--note-origin-x, 50%) var(--note-origin-y, 0)`, at `--duration-fast` with `--ease-smooth-out`.
  - Keyboard (Enter) opens with no origin and no scale: opacity only, 120 ms.
- **Accept.** The document visibly grows from the card that was clicked.

#### 4.12 Notes format bar and link bubble (N, tens, M)

- **Files.** `views/notes/FormatBar.tsx:203-268`.
- **Motion.**
  - Wrap the BubbleMenu content in a div with a local class `.note-bubble-enter`: `@starting-style { opacity: 0; transform: translateY(2px) scale(0.98) }`, transition 150 ms `--ease-out`, `transform-origin: bottom center`.
  - Mode switches (buttons, link, turn-into): key the content and add `t-section-enter`.
  - Selection changes made by keyboard re-position without animation, because the bubble stays mounted.
- **Reduced motion.** Opacity only.

#### 4.13 Note delete (N, occ, M)

- **Files.** `NotesGallery.tsx:292-295`.
- **Motion.** The card gets `t-pop-out` for 150 ms, then is removed. Virtual rows reflow instantly afterwards (no FLIP inside virtual rows).

#### 4.14 Notes list ↔ gallery (N, occ, M)

- **Files.** `NotesGalleryChrome.tsx:78-80`, `NotesGallery.tsx`.
- **Motion.** Key the content on layout and add `t-section-enter`.

#### 4.15 Notes empty / first run (N, rare, M)

- **Files.** `NotesGallery.tsx:324-357`.
- **Motion.** `t-stagger`, the full 500 ms tempo: a rare first-run moment, so the delight budget applies.

#### 4.16 Remove `notes-enter` page fade (F, LOW)

- **Files.** `notes.css:110-117`.
- **Target.** After 1.1 lands, delete the `.notes-page.notes-enter` keyframe use, which is a bare 160 ms fade with the `ease-out` keyword. Keep `.note-doc`'s own enter from 4.11.
- **Dependency.** Package 1.1.

#### 4.17 Notes outline rail (N, tens, M)

- **Files.** `notes.css:925-965`, `NoteOutline.tsx:94`.
- **Motion.** Keep the width snap. Labels inside the expanded rail get opacity 0 → 1 plus `translateX(-4px)` → 0, 150 ms `--ease-out`, with a 30 ms delay, using `:hover`-scoped transitions.

#### 4.18 Tasks list ↔ board (N, occ, M)

- **Files.** `TasksPage.tsx:129-141,188-199`, `tasks.css:177-186`.
- **Motion.** Key the view and add `t-section-enter`. Replace the `.tk-seg` toggle with `useSlidingPill` (`.t-tabs`/`.t-tabs-pill`, `data-tab-active`).

#### 4.19 Task created (N, tens, keyboard, M)

- **Files.** `QuickAdd.tsx:108-155`, `TaskList.tsx`, `TaskBoard.tsx`.
- **Motion.** The new row or card renders instantly, with `t-flash` (0.7). It is no-travel feedback, so it is allowed for keyboard input. Remove the class on `animationend`. No travel, no delay.

#### 4.20 Task status change (N, tens, M)

- **Files.** `TaskList.tsx:83-105`, `TaskBoard.tsx`.
- **Motion.**
  - Pointer status changes (menu, checkbox): call `flip.capture()` on the list or board container before the store update. Items carry `data-flip-key={task.id}`. The row glides to its new group.
  - Keyboard `S`: instant, plus `t-flash` on the moved row.
  - Not during a dnd-kit drag.
- **Accept.** Marking a To-do task done via its checkbox shows it sliding into Done.

#### 4.21 Task check (N, tens, M)

- **Files.** `TaskCheck.tsx`, `tasks.css:1582-1603`.
- **Motion.**
  - Fill: `background-color` / `border-color` transitions at `--duration-quick` with `--ease-out`.
  - Tick: render the SVG path with `t-check-path` (24 px dash draw at 250 ms after an 80 ms delay), as `components/kit/checkbox.tsx:50` does.
  - When the task reaches Done, the status glyph plays `t-pop` once. A small reward on a light element.

#### 4.22 Acceptance criteria tick (N, tens, M)

- **Files.** `TaskDetail.tsx:418-424`.
- **Motion.** The conditional SVG tick gets `t-check-path`.

#### 4.23 Board and list drag (F, MED, M)

- **Files.** `TaskBoard.tsx:106,131`, `TaskList.tsx:129,190`, `tasks.css:587,759,822-862`.
- **Target.**
  - `DragOverlay dropAnimation={reducedMotion ? null : { duration: 250, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}`.
  - `useSortable({ transition: { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" } })`.
  - Overlay pickup: keep the 1° rotate, add a `scale: 1.02` keyframe-in at `--duration-micro`, and move the bigger shadow to a `::before` opacity layer.
  - `.tk-drop-line`: `transition: opacity var(--duration-quick) var(--ease-out), transform var(--duration-quick) var(--ease-out)`.

#### 4.24 Task groups (N, occ, M)

- **Files.** `TaskList.tsx:85,105`, `TaskBoard.tsx:94`.
- **Motion.** Group collapse uses `DisclosureRegion`. Rows revealed by "N more" get `t-row-enter` with a 20 ms cascade, capped at 8.

#### 4.25 Task page open (N, tens, M)

- **Files.** `TasksPage.tsx:115-117`, `TaskDetail.tsx:96-113`.
- **Motion.** Pointer open: the `TaskContent` root gets `t-page-enter`. Enter, j and k are instant (`lastInputWasPointer`).

#### 4.26 Tasks hints, empty, error (N, rare, M)

- **Files.** `tasks.css:454,473`, `TasksPage.tsx:170-180`.
- **Motion.**
  - Hints bar hide: replace `visibility: hidden` with `opacity 0` + `pointer-events: none`, transitioned at `--duration-quick`.
  - Empty and error states: `t-stagger` with `data-tempo="quick"`.

#### 4.27 PR tab panels (N, tens, M)

- **Files.** `PrReview.tsx:150-195`.
- **Motion.** Key the panel on the tab and add `t-section-enter`, for pointer only. Arrow keys switch instantly.

#### 4.28 PR list rows after loading (N, occ, M)

- **Files.** `PrList.tsx:374-375`, `PrStates.tsx:86-125`.
- **Motion.** On the first load of the page only, the first 8 rows get `t-row-enter` with a 20 ms cascade. Refreshes do not animate.

#### 4.29 PR review submit (N, occ, M)

- **Files.** `PrReviewPopover.tsx:62-70,267-283`, `usePrActions.ts:91-133`.
- **Motion.**
  - "Submitting…" label: `TextSwap`.
  - On success, the submit button icon shows a `t-success` check for 600 ms, then the popover closes. Use the existing toast if one is already sent.
  - On error, the inline alert gets `t-appear` and the button row gets `t-shake`.

#### 4.30 PrHeader copy (F, LOW, M)

- **Files.** `PrHeader.tsx:93-100`.
- **Target.** `IconSwap`, the same as `PrTopBar.tsx:147`.

#### 4.31 PR checks (N, occ, M)

- **Files.** `review.css:191`, `PrChecksRing.tsx`.
- **Motion.** Rows expand inside `DisclosureRegion`, replacing the `display` toggle. Ring segments get `transition: stroke-dashoffset var(--duration-slow) var(--ease-out)`.

#### 4.32 Usage daily bars (N, occ, M)

- **Files.** `UsagePage.tsx:168`, `settings.css:75-77`.
- **Today.** An inline `height:%` snaps when the period changes.
- **Target.**
  - Give each bar a fixed full height with `transform-origin: bottom` and `transform: scaleY(v)`, driven inline from the same value.
  - Add `transition: transform var(--duration-slow) var(--ease-out)`.
  - First view, not launch: grow from `scaleY(0)` with `@starting-style` and a 15 ms per-bar delay, capped at 300 ms in total.
  - The hover opacity becomes a 100 ms transition.
- **Gate 4.** This is data the user reads. The change only bridges value changes and does not loop.
- **Reduced motion.** Instant.

#### 4.33 Usage breakdown meters (N, occ, M)

- **Files.** `UsagePage.tsx:174`, `settings.css:85-86`.
- **Target.** Replace `width:%` with `scaleX` and `transform-origin: left` (right in RTL), transitioned at `--duration-slow` with `--ease-out`. Copy `LimitMeter` (`kybern.css:805-825`).

#### 4.34 Limit meter fill-in (N, occ, M)

- **Files.** `components/kybern/LimitMeter.tsx:11`.
- **Motion.** When the meter is not launch-mounted, start at `scaleX(0)` via `@starting-style`, so the existing 400 ms transition fills it.

#### 4.35 Usage group segments (N, occ, M)

- **Files.** `UsagePage.tsx:114`, `settings.css:72-74`.
- **Motion.** `useSlidingPill`.

#### 4.36 Settings save failure (N, rare, M)

- **Files.** `SettingsScreen.tsx:212-224`.
- **Motion.** On rollback, the setting's row gets `t-shake`, next to the existing toast.

#### 4.37 Theme choice (F, LOW)

- **Files.** `settings.css:44-45`.
- **Target.** `box-shadow var(--duration-quick) var(--ease-out)`.

#### 4.38 Integrations (N, rare, M)

- **Files.** `Integrations.tsx:226-300,367`.
- **Motion.**
  - Segments: sliding pill.
  - Status line (`<p key={message}>`): `TextSwap`.
  - "Working…" labels: `TextSwap`.
  - The list after loading: `t-section-enter`.

#### 4.39 Add account (N, rare, M)

- **Files.** `AddAccountSheet.tsx:131,332,483,641`.
- **Motion.**
  - The step content leaves through `usePresence` (150 ms, `--ease-exit`) before the next step's `account-step-in`.
  - The `AnimatedHeight` stays (a dialog height change is the accepted modal exception), with its easing tokenised to `--ease-smooth-out` at `--duration-fast`.
  - Copy button: `IconSwap`.
  - Wrong code (`PasteStep key={api.wrongCodes}`): the input gets `t-shake`.

#### 4.40 Toasts (N, occ, M)

- **Files.** `components/ui/sonner.tsx`.
- **Motion.**
  - Through sonner's `toastOptions.classNames`, add a class whose enter is opacity plus a clearing 2 px blur at `--toast-open` (350 ms) with `--toast-ease`, and whose exit is the mirrored, faster `--toast-close` (250 ms). These tokens already exist in `motion.css:69-74`.
  - Keep sonner's stacking, and keep X-dismiss with no swipe. This matches the GPUIX toast decision.
  - If sonner's inline transforms fight the class, **stop and report** rather than forking sonner.

---

## Part 4 — Rejected candidates (the Gate)

| # | Candidate | Killed by |
| --- | --- | --- |
| R1 | Thread ↔ thread switch transition (measured 0 today, kept) | **Frequency**: core navigation, 100+/day, sidebar and shortcuts. |
| R2 | ⌘K palette open/close animation | **Frequency + keyboard**: becomes instant (1.3). |
| R3 | Composer and Notes slash, mention and skill menus entering | **Keyboard/typing-initiated**, tens/day. They appear as you type. |
| R4 | Animating filter results (sidebar filter, palette results, model search, explorer search) | **Typing never animates.** |
| R5 | Route header title TextSwap on every page change | **Frequency**, 100+/day. The thread header's existing TextSwap stays, but it is not extended. |
| R6 | Task j/k navigation and Enter-to-open motion | **Keyboard**, 100+/day. |
| R7 | Animating the composer stack's height when panels come and go | **Function/perf**: layout on the scroll-pin hot path (`composer-stack` report). |
| R8 | Colour crossfade when code highlighting arrives | **Perf**: thousands of spans; worker-output hot path. |
| R9 | Animated reflow on code-block wrap toggle | **Function**: layout on long code. |
| R10 | Morphing the preview iframe during device-size changes | **Perf**: per-frame iframe reflow. |
| R11 | FLIP of Activity rows moving Active → Recent | **Perf**: virtual list positions rows itself. |
| R12 | Replacing the sidebar's width-based offcanvas with a transform | **Function**: it is the established layout. Its cost is bounded, and the lag is fixed instead (1.5). |
| R13 | Hover lift or scale on sidebar, task and PR rows | **Frequency**: tens to 100+ hovers a day. Colour change only. |
| R14 | Ambient background life (gradient drift, breathing cards) on functional surfaces | **Function**: information-dense UI. The running indicators already carry the ambient layer. |
| R15 | Sidebar rename input appear | **Frequency/keyboard**: an in-place edit; focus moves at once. |
| R16 | Animating diff lines in or out | **Function**: data the user reads. |
| R17 | Line-by-line animation of terminal output | **Function and perf**: the WebGL canvas. |
| R18 | Settings keyboard section navigation motion | **Keyboard**: already instant by design (`data-keyboard`). |
| R19 | Typing-cursor or bubble "lift-off" animation when pressing Enter to send | **Keyboard**, 100+/day. Only the bubble's existing entrance stays (and the double-show fix, 2.41). |
| R20 | Bounce or overshoot on panels, menus and dialogs | **Personality**: Corporate/Premium. Overshoot only on badges, checks and pops. |
| R21 | Animating the stepped sidebar running spinner smoothly | **By design** (WebKit backdrop repaint cost, brief). |

## Part 5 — Verdict

The desktop already has a good vocabulary, but large areas never use it:
- **The vocabulary:** `t-*` classes, TextSwap, IconSwap, the sliding pill, matrix loaders.
- **The gaps:**
  - The Tasks, Usage and PR pages, and every page switch, measured **zero** animations.
  - Context menus and selects have no motion at all, because of inert or missing classes.
  - Resolved panels, removed rows and closing chips all vanish.
  - State glyphs hard-swap across sidebar, lineage, delegation and activity.

At the same time, a few places animate where they should not:
- ⌘K.
- The Draft stagger on ⌘N and ⌘[.
- `padding` on every sidebar hover.
- The dock's `width` spring, including under reduced motion.
- A 2,024-span re-fade when opening a streaming thread.

**Order of leverage:**
1. **Package 0**, then the HIGH fixes: 0.12, 1.2, 1.3, 1.4, 1.6, 2.11, 2.14, 2.29, 4.1, 4.2. These remove motion that hurts and switch on motion that was meant to be there.
2. Then the coverage items, which make the app feel alive without slowing any repeated action:
   - exits through `usePresence` / `t-pop-out`;
   - glyph IconSwaps;
   - FLIP for archive, pin and status moves;
   - page enters for pointer navigation.

The highest single-item leverage is **0.12** (`StreamWords`): it is on the hottest path and fires on every visit to a running thread.

### Mirror to GPUIX

136 of the 161 items carry `M`. The GPUIX lane should check each one against `apps/gpuix/src/motion/` and its native motion patches. Use the same durations and curves (the token table in Part 2) so the two clients stay consistent.

Desktop-only items concern web-only mechanics and are not mirrored: tailwind-merge, missing keyframes, WebKit layers and `will-change`, dnd-kit, Base UI classes, sonner.
