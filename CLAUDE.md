@AGENTS.md

## Claude Code notes

- Work in the worktree you were started in. Never `cd` into the main checkout.
- The desktop app is the Tauri + React client in `apps/desktop`; the GPUI
  client on the `gpui` branch is archived and must not be ported back.
- Keep the existing look: reuse `components/kit` and `lib/kit` before
  writing new styles, and screenshot the app window after UI changes.

## Performance and visual quality

Apply the performance rules in `AGENTS.md` to every desktop UI change. Before
editing a rendering hot path, read [the performance guide](apps/desktop/perf/README.md)
for the measured regressions, their fixes, and the matching native checks.

- Preserve the polished kit appearance while bounding rendering work. Reuse
  stable history, virtual rows, worker queues, paced streaming, and shared
  visibility handling instead of introducing a parallel implementation.
- Validate both appearance and interaction: long threads, typing during output,
  navigation, selection, focus, reading position, and the relevant theme states.
- Treat worker fallback text and hidden DOM as diagnostic signals. Confirm the
  expected formatted content and reachable controls before claiming success.
- Keep findings reproducible. Record the workload and measurement boundary;
  isolated CPU or frame results do not establish whole-app energy savings.
