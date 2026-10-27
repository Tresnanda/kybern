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
| `flow.ts` | Scene store (`go`, `next`, `back`, `finishFlow`), the completion mark, the developer flags. |
| `Welcome.tsx` | The layer mounted last in `App.tsx`: canvas, scene transitions (`Presence`), progress, the shared mark's flight. |
| `Grid.tsx` | The dot grid (one tinted SVG pattern, `edgeFade` toward the edges) and the camera pan/swell. |
| `Hero.tsx`, `Cta.tsx` | The first scene; the 44 px primary with press, ripple, shine and arrow nudge. |
| `AgentsScene.tsx`, `Constellation.tsx`, `AgentPopover.tsx`, `TerminalSheet.tsx`, `agentsStore.ts` | Agent detection (`providers.list`, accounts, `cursor.status`), the six tiles, the popover, the typed-not-run terminal sheet, browser sign-in through `dialogs/Account.tsx`. |
| `ProjectsScene.tsx`, `projectsStore.ts`, `projects.ts` | `sessions.scan_projects` / `sessions.import_all`, import modes, rows. |
| `PreferencesScene.tsx`, `AppearancePicker.tsx`, `WindowMaterialPicker.tsx`, `PermissionList.tsx` | Theme, window material (writes through `settings/appearance.ts`), default permission mode. |
| `Handoff.tsx` | The way out: shell entrance, suggestion chips, typed placeholder, the import toast. |
| `getStarted.ts`, `getStartedStore.ts`, `GetStartedCard.tsx` | The Get-started card on Home: which items exist and when each ticks (pure, `getStarted.test.ts`), the persisted state and machine facts (CLI on PATH, paired devices, Computer use, notifications), and the card with its `GlideBox`. Hide and fold change the card's height; everything under it glides by 13/20 of that. |
| `SkippedDialog.tsx` | "N chats were skipped" (View skipped): from the import toast and the Projects scene. |
| `sceneKit.tsx`, `magnet.ts` | The scene heading that takes focus on arrival, ⌘↵ / Ctrl+Enter for the scene's primary, and the magnetic primary (a spring loop writing `setSubtreeTranslation`, no React commit per pointer move). |
| `motion.tsx` | Shared helpers: `In` (rise), `Words`, `Roll` (rolling numbers), `stateTransform`. |

Scenes mount and unmount on navigation, so everything that must survive lives in module stores.

## Hooks outside this folder

`App.tsx` (layer, shell entrance, Draft key), `shell/Connection.tsx` (no static empty screen once the flow ended), `Draft.tsx`
(suggestions, typed placeholder, the card's slot and `GlideBox`), `Composer.tsx` (`fillRef`), `shell/toasts.tsx` (a `progress` bar),
`Sidebar.tsx` (`HandoffSlide` around the first rows).

## Get-started card

Exists after a whole run ends (`needs` is fixed then: an agent item only when none was ready, an import item only when import was
skipped or "Don't import chats" was chosen) and only on this Mac's own environment. State is `kybern.getstarted` in `gpuix-ui.json`;
an install that finished before the card existed has none. **Import** reopens the flow on the Projects scene alone (`flow.only`):
Back and Continue return to the app, and the card is not restarted. Hide is permanent.
