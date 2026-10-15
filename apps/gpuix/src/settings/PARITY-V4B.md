# Settings and PR parity V4b

Base: `59e3e9fc`, worktree `/Users/mymac/projects/ade-gpuix-settings`, branch `gpuix/settings`. Changes remain uncommitted; no native source or dependency changes.

## Changes

- PR toolbar uses matching glyphs for refresh, link, GitHub, agent, review, and merge. Changes shows additions/deletions; Timeline shows the comment count. Segments retain their keyboard navigation and sliding selection. Wide inbox hides Back; compact inbox retains it.
- PR descriptions and timeline bodies use the cached native Markdown theme introduced in package 5. Summary metadata now includes state/reviewer/check glyphs, compact copy action, and matching section spacing. Timeline includes author avatars, state chips, real checkbox controls, and pagination after the scrollable entries.
- Review popover uses explicit reduced-motion behavior; tightened headings and radio spacing to match its pair.
- Notifications reads native `status()`, requests permission only from the user action, posts the test notification after permission is granted, and shows `notifications.reason` when unsupported. No real permission request was issued during tests. Packaged permission delivery was not retested.
- Background retains the existing zero → Off behavior, dims the Off unit, uses the desktop input fill/border, and removes the extra footer row. Card/row padding matches the captured reference.
- Translucency already defaults off in both initialization and environment switching on this base. Saved Boolean preferences remain respected; no redundant edit.

## Screenshot pairs

1280×820 logical, 2× reference, both themes, fresh isolated fixtures. Whole-frame pixels differing by more than 24/255; no content-only crops for search, hover, focus, or dialogs. Each percentage links to its pair (Tauri left, GPUIX right). Companion `-tauri.png`, `-gpuix.png`, and `-diff.png` files are retained beside it. Later app-only recaptures reuse the unchanged fresh Tauri references.

| Screen | Dark | Light |
|---|---:|---:|
| dialog-account | [2.17%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-account-dark-pair.png) | [89.88%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-account-light-pair.png) |
| dialog-project | [2.41%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-project-dark-pair.png) | [77.87%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-project-light-pair.png) |
| dialog-worktree | [4.42%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-worktree-dark-pair.png) | [85.23%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-worktree-light-pair.png) |
| dialog-worktree-checked | [4.44%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-worktree-checked-dark-pair.png) | [85.24%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/dialog-worktree-checked-light-pair.png) |
| pulls-changes | [20.69%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-changes-dark-pair.png) | [12.51%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-changes-light-pair.png) |
| pulls-draft | [5.43%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-draft-dark-pair.png) | [5.27%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-draft-light-pair.png) |
| pulls-empty | [1.33%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-empty-dark-pair.png) | [1.24%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-empty-light-pair.png) |
| pulls-error | [1.32%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-error-dark-pair.png) | [1.22%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-error-light-pair.png) |
| pulls-hover | [2.86%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-hover-dark-pair.png) | [2.76%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-hover-light-pair.png) |
| pulls-list | [2.87%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-list-dark-pair.png) | [2.76%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-list-light-pair.png) |
| pulls-merge-menu | [5.41%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-merge-menu-dark-pair.png) | [5.23%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-merge-menu-light-pair.png) |
| pulls-review | [5.71%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-review-dark-pair.png) | [5.47%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-review-light-pair.png) |
| pulls-summary | [5.33%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-summary-dark-pair.png) | [5.10%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-summary-light-pair.png) |
| pulls-timeline | [4.86%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-timeline-dark-pair.png) | [4.72%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/pulls-timeline-light-pair.png) |
| settings-background | [3.08%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-background-dark-pair.png) | [2.98%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-background-light-pair.png) |
| settings-focus | [2.53%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-focus-dark-pair.png) | [2.28%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-focus-light-pair.png) |
| settings-hover | [2.48%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-hover-dark-pair.png) | [2.25%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-hover-light-pair.png) |
| settings-notifications | [1.85%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-notifications-dark-pair.png) | [1.78%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-notifications-light-pair.png) |
| settings-search | [1.95%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-search-dark-pair.png) | [1.73%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-search-light-pair.png) |
| settings-search-empty | [1.99%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-search-empty-dark-pair.png) | [1.77%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/settings-search-empty-light-pair.png) |
| usage-empty | [2.75%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/usage-empty-dark-pair.png) | [2.60%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/usage-empty-light-pair.png) |
| usage-populated | [2.53%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/usage-populated-dark-pair.png) | [2.46%](/Users/mymac/projects/ade/previews/gpuix/settings-v4b/usage-populated-light-pair.png) |

## Remaining differences and dependencies

**The final menu/dialog pairs require the shared PopupLayer reduced-motion fix.** With the parent's authorization, captures temporarily used `useState(stillProp || REDUCED_MOTION)` in `src/composer/Menu.tsx`. That line was restored before handoff and is NOT in this diff; the conversation owner is integrating it. Review independently respects reduced motion in its owned component.

The newly visible light dialogs have a severely over-dark backdrop: roughly #303030 rather than #666666 in the reference. This explains the 77–90% whole-frame results; their cards are visible and mostly aligned. The shared layer/native opacity issue is reported to the orchestrator. No app-specific dim compensation was introduced. These are **not visual-parity sign-offs**.

For PRs, only Changes contains a native diff renderer. All other PR screens have **0 percentage points from native diff rendering**. Their remaining errors include common shell/list spacing and type rasterization, Markdown marker/gutter/heading metrics, summary metadata, and popover input material/spacing. These have not all been causally separated into app vs native text rendering.

Changes: **20.69% dark / 12.51% light** total. The conservative union of the diff frames (logical x=646…1256, y=110…808) contributes **16.13 / 8.09 percentage points**; outside contributes **4.56 / 4.42 points**. This is region attribution, not proof that every pixel inside is caused by native code: it includes differing app-side frame offsets/header. The native renderer still differs in syntax/word-diff treatment, gutters, hunk headings, and line backgrounds. App-side file-list widths, row composition, and pagination placement also remain different. No diff renderer changes or screenshot substitution.

`visual/screens/settings.metrics.swift` reproduces whole-frame and diff-region metrics; run optimized for speed. Final raw values are retained in `previews/gpuix/settings-v4b/metrics.txt` in the conversation checkout.

## Validation

- `pnpm typecheck`: pass.
- `bun test ./src`: 43 pass, 0 fail, 402 assertions.
- `src/pulls/verify.actions.ts`: pass dark and light; all six mock PR actions, reviewed head, linked checkout, failure draft retention, empty list. The wide-layout test refreshes its still-visible inbox rather than clicking the hidden Back button.
- `src/settings/verify.native.ts`: pass dark and light; added assertion for the unbundled notification reason, without clicking permission access.
- `src/settings/verify.scratch.ts`: pass; switch round-trip, external settings event, numeric clamp/save, section navigation/search/Escape/shortcut/Back.
- `scripts/combined-pointer-check.ts`: pass pointer and Space changes, repeated after final integration changes.
- `src/usage/verify.native.ts --reduced`: pass usage grouping/period, 2400-line diff, inline draft/remount retention, timeline paging, send/merge UI, sidebar peek, recovery states; no write RPCs. Pagination test now scrolls to the end of the timeline before advancing.
- `git diff --check`: pass.

## Cleanup

Stopped only this task's isolated daemon and Vite processes, including Vite children left by repeated `--fresh --keep` runs. Removed the task-owned `visual-pair-91065263` scratch tree, compiled metric helper, and copied 23 MiB native binary after checking it had no open handles. Original worktree registration and source remain intact. Reused 225 MiB dependencies remain for subsequent checks. Approximately 80 MiB screenshot/verification deliverables remain under the conversation's `previews/gpuix/settings-v4b`.

Free space: 64 GiB before; 61 GiB at final checks. Other workers ran concurrently; no claim that this task used the entire difference. No Rust build, simulator install, real account/Keychain/GitHub action, installed UI launch, normal `~/.kybern` data, or port 4219 use.
