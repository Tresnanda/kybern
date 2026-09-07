# Turn lifecycle, image previews, and release builds

Changes and verification on 2026-09-07, based on v0.2.4 main.
The installed Kybern app and its daemon remained running throughout. All
builds used a separate worktree; UI checks used isolated native WebKit fixtures
with synthetic events and the production CSP.

## Behavior

- Claude foreground results stay provisional while background agents or
  processes are active. Three consecutive task waves retain the parent turn,
  stable message identities, and cumulative usage before one final completion.
  Long-lived monitors retain their existing lifecycle.
- Desktop completion alerts check current background-task state after native
  focus lookup and deduplicate repeated completions of the same turn.
- Explicit agent images remain chronological during work and appear after
  settled work. Generated-image tool deliverables join the final gallery;
  inspection screenshots stay in their tool results.
- Composer attachments and sent image bubbles open the existing preview dialog.
  Closing returns focus to the thumbnail; removing an attachment still works.
- Sent message paragraphs retain soft newlines.
- The environment menu uses aligned icons and two-line environment rows,
  selected radio semantics, and a new-window icon beside each environment.
  The icon opens that environment without switching the current window. Names wrap.

## Verification

- Desktop: 106 unit tests, TypeScript checks, ESLint, and production build passed.
- Daemon: 88 library tests passed, one ignored. Rust formatting and Clippy for
  daemon and drivers, including all targets, passed.
- Native WebKit: artifacts, continuation, and chat-fixes fixtures passed.
  The new fixture covers light/dark previews, focus return, attachment removal,
  rendered newline geometry, image placement before/after completion, generated
  deliverables, and opening a screenshot within a grouped tool result.
- Environment checks cover icon/text alignment, selected state, keyboard focus on each
  new-window action, target selection without switching the current window, long names, 150% zoom, and RTL.
- Workflow YAML/actionlint and shell syntax checks passed.
- Apple Silicon successfully cross-compiled the Intel release daemon and Tauri
  shell and packaged an ad-hoc-signed Intel DMG. Both executables passed lipo
  architecture checks. No application was installed or launched.

## Release bottlenecks

Desktop run 34084630136 took 30m59s. Its Intel build took 26m9s, followed by
roughly three minutes saving a cache; the ARM build took 7m51s. Logs showed
cache misses. The separate Release run 34084630144 took about 12m34s.

The workflow now warms release dependencies on main, where future tags can
restore them, and avoids saving tag-local caches. Intel builds use an ARM Mac
runner with an explicit target. Artifact uploads skip the duplicate unpacked
app and disable redundant compression of existing archives.

References: [GitHub cache restrictions](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#restrictions-for-accessing-a-cache)
and [Tauri GitHub build targets](https://v2.tauri.app/distribute/pipelines/github/).

These changes have no measured CI speedup yet; the next release must establish
that. Updater signing was not exercised locally because no signing key was
provided. The reported SSH conversation was not replayed against production;
lifecycle coverage uses deterministic driver events and notification tests.
