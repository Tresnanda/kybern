# First-run onboarding

A brand-new install opens a full-window flow instead of the empty Draft: hero → agents → projects → preferences → the real app.
Contract and look: `.kybern-artifacts/onboarding-cinematic/SPEC.md` (outside the repo). Flat canvas with a dot grid; no gradient,
no glass card.

## Opening it again

```sh
KYBERN_ONBOARDING=1 pnpm dev                       # open it on an existing data directory (once per run)
KYBERN_ONBOARDING_SCENE=agents|projects|prefs ...  # start on a later scene (development, screenshots)
```

The flow opens when the lists have loaded and there is no project, no thread and no `kybern.onboarding.completed` mark (stored per
environment in `gpuix-ui.json`, `shell/persist.ts`). A window with data and no mark is marked at once, so deleting everything
later does not bring the flow back. Finishing or "Set up later" writes the mark.

## Files

| File | What |
| --- | --- |
| `model.ts` | Pure rules, tested in `model.test.ts`: the gate, import mode → `limit`, default agent, the agents status line, tile state from the daemon, window-material options. |
| `flow.ts` | Scene store (`go`, `goFrom`: a move only from the scene on screen, so a doubled press moves once), `finishFlow` (the shell mounts under the welcome, which fades out once the shell has drawn and settled), the completion mark, `resetFlow`, the developer flags. |
| `lifecycle.ts` | Imported by `Welcome.tsx`: a new environment resets the flow, scan and agents (its own first run); ending the flow stops a running scan. |
| `once.ts` | `createPress`: the guard on a scene's primary against a double click or key repeat. |
| `announce.ts` | The one live region and what it says: an import starting, each project finishing, the end, the default agent changing (never a tick). |
| `Welcome.tsx` | The layer mounted last in `App.tsx`: canvas, scene transitions (`Presence`, each scene its own fill island), progress, the shared mark's flight. |
| `Grid.tsx` | The dot grid (one tinted SVG pattern, `edgeFade` toward the edges) and the camera pan/swell. |
| `Hero.tsx`, `Cta.tsx` | The first scene; the 44 px primary with press, ripple, shine and arrow nudge. |
| `AgentsScene.tsx`, `Constellation.tsx`, `AgentPopover.tsx`, `TerminalSheet.tsx`, `agentsStore.ts` | Agent detection (`providers.list`, accounts, `cursor.status`), the six tiles, the popover, the typed-not-run terminal sheet, browser sign-in through `dialogs/Account.tsx`. |
| `ProjectsScene.tsx`, `projectsStore.ts`, `projects.ts` | `sessions.scan_projects` / `sessions.import_all`, import modes, rows. |
| `PreferencesScene.tsx`, `AppearancePicker.tsx`, `WindowMaterialPicker.tsx`, `PermissionList.tsx` | Theme, window material (writes through `settings/appearance.ts`), default permission mode. |
| `Handoff.tsx` | The way out: `useShellReady` (the welcome fades only once the app under it has settled), the import toast (follows the job until its summary), the announcer. No entrance of its own: the app is simply there. |
| `SkippedDialog.tsx`, `skipped.ts` | "N chats were skipped" (View skipped): from the import toast and the Projects scene; the pure title and grouping in `skipped.ts` (`skipped.test.ts`). |
| `sceneKit.tsx`, `magnet.ts` | The scene heading that takes focus on arrival, ⌘↵ / Ctrl+Enter for the scene's primary, `Later` (mounts a subtree a few frames after the scene), and the magnetic primary (a spring loop writing `setSubtreeTranslation`, no React commit per pointer move). |
| `motion.tsx` | Shared helpers: `In` (rise), `Words`, `Roll` (rolling numbers: each column holds only the digits it rolls through), `stateTransform`. |

Scenes mount and unmount on navigation, so everything that must survive lives in module stores.

## Hooks outside this folder

`App.tsx` (the layer, `useShellReady`, the shell mounted only once the flow ends), `shell/Connection.tsx` (no static empty screen
once the flow ended), `shell/toasts.tsx` (a `progress` bar). Home, the Draft, the composer and the sidebar have no onboarding code:
after Start building the welcome fades over the app as it is.

## Frame cost

The flow must draw every frame in under 16.7 ms on an M-series Mac, about 8 ms where it can (120 Hz displays). Measure per draw,
never by the gaps between frame timestamps (they include idle time):

```sh
bun scripts/onboarding-perf.ts <label> [--theme light] [--runs 2] [--islands]   # every moment: draws, mean/p95/max render ms, layout calls
BENCH_SCENE=projects bun scripts/onboarding-perf.ts <label>                      # mode switches and Select all only
BENCH_SCENE=prefs bun scripts/onboarding-perf.ts <label>                         # slider drags
bun scripts/onboarding-orange-check.ts [--rendered] [--theme light]              # the permission list stays free of orange
bun scripts/onboarding-present-dump.ts <label> [--strips <dir>]                   # what each step change presented, scanned for flashes
```

Each run starts its own scratch daemon and stops every daemon serving its data dir at the end (the window may start one too).
`--islands` adds `KYBERN_DEBUG_ISLANDS` and `KYBERN_MOTION_TRACE` lines to the JSON. What the numbers taught (October 2026):

- **One commit, one whole-scene draw.** Each scene is a fill island and the Projects list a `cacheLayout` fill island, so a commit
  lays out one scene, not the window. Prefer one commit with paint delays over a commit per row or per tick (`CountLine`).
- **No blur on entrances that come in groups.** Every settling blur re-renders the window once. `riseTransform` and `Words` do not
  blur; pass `blur={false}` to swaps that change together.
- **Count elements, not islands.** A rolling digit of ten labels cost the same inline or cached; fewer labels is what helped.
- **Spread the first draw.** A scene's first draw builds, shapes and rasterizes all of it. `Later` mounts the heavy parts (rings,
  tiles, rows, lists, pickers) a frame or more later, before any is visible; give it a same-size placeholder.
- **`scrollToItem` and `focusElement` refresh the whole window on macOS** (every island rebuilds): call them only when needed.
- **Never hide something at rest with a retained opacity of 0.** A full draw can present it before the opacity is re-applied: the
  Full access tint flashed orange that way. Mount it only while it shows (`Presence`).
- **Islands outside scopes, never inside one.** A cached island that replayed inside a `paintTransform` scope lost the scopes
  nested in it (fixed in the fork, `KYBERN_NESTED_SCOPE_REPLAY`): every step change presented frames with both scenes at full
  opacity. `IslandPresence` (`Welcome.tsx`) puts the layer's and each scene's island outside its `Presence`, and drops the scope
  at rest (`retainAtRest={false}`), so the window and the Welcome layer never replay an island inside a scope. Nested islands
  inside a scene (the Projects list) still replay inside the scene's 620 ms entrance; only the fork fix covers those.
- **Focus after the entrance.** The heading takes focus 700 ms after its scene arrives (`sceneKit.tsx`): `focusElement` is a
  full window refresh on macOS, which inside the entrance was one more full draw.
- The app's own first draws under the welcome (20–35 ms) happen while the welcome is still opaque; the fade waits for them.
