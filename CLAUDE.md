@AGENTS.md

## Claude Code notes

- Work in the worktree you were started in. Never `cd` into the main checkout.
- The desktop app is the Tauri + React client in `apps/desktop`; the GPUI
  client on the `gpui` branch is archived and must not be ported back.
- Keep the existing look: reuse `components/kit` and `lib/kit` before
  writing new styles, and screenshot the app window after UI changes.
