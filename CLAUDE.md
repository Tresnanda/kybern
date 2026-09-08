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

## Mobile companion

The Android/iOS app is in `apps/mobile`; read its README and the Mobile app
section of `AGENTS.md` before editing it. Share protocol, transport, transcript,
and composer logic through `packages/kybern-client`; use the mobile primitives,
Ink tokens, and paired SF/Material icon map for native UI.

`pnpm start:go --lan` targets Expo Go; `pnpm start --lan` targets an installed
development app. EAS `preview` creates an installable Android APK that runs
without Metro. The EAS owner is the personal `treshnanda` account, never
`beme-mobile`. Release-only native behavior, especially networking, must be
checked independently of Expo Go. Keep the iOS scene and Android local-network
config plugins until the corresponding platform requirements change.

Mobile has its own app version and EAS build numbers. Daemon, CLI, and desktop
remain one versioned release unit. Pushing `main` does not publish either one;
see the root README's Releasing section before changing tags or release scripts.
Run mobile typecheck/tests and both platform exports for mobile/shared changes.
Mobile 0.1.1 supports EAS Update on preview/production channels with native
fingerprint compatibility. Native changes need a new build; updates must use the
matching EAS environment and runtime. Follow the mobile README for commands.
