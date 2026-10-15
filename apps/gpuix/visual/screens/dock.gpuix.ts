import { click, go, park, settle, type Step } from '../screens.gpuix.ts'

const open: Step = async (app, fx) => {
  await click(app, `thread-${fx.extra.dock!.thread}`)
  await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await click(app, 'dock-toggle')
  await settle(600)
}
const panel = (tab: string): Step => async (app, fx) => {
  await open(app, fx)
  await click(app, 'dock-add')
  await click(app, `dock-add-${tab}`)
  await settle(1000)
  await park(app)
}
export const screens: Record<string, Step> = {
  'dock-live': async (app, fx) => { await click(app, `thread-${fx.extra.dock!.thread}`); await app.getByTestId('computer-live-image').waitFor({ timeoutMs: 15000 }); await settle(700); await park(app) },
  'dock-preview-opened': panel('preview'),
  'dock-preview-mini': async (app, fx) => { await click(app, `thread-${fx.extra.dock!.thread}`); await app.getByTestId('preview-mini').waitFor(); await settle(700); await park(app) },
  'dock-diff-file': async (app, fx) => { await panel('changes')(app, fx); await click(app, 'dock-file-diff-src/dock-example.ts'); await settle(1000); await park(app) },
  'dock-narrow': async (app, fx) => { await panel('agents')(app, fx); await app.getByTestId('dock-overlay').waitFor(); await park(app) },
  'dock-project': async (app, fx) => { await open(app, { ...fx, extra: { ...fx.extra, dock: { thread: fx.extra.dock!.coordinator } } }); await click(app, 'dock-add'); await click(app, 'dock-add-project'); await settle(1000); await park(app) },
  'dock-explorer-file': async (app, fx) => { await panel('explorer')(app, fx); await click(app, 'dock-file-src'); await click(app, 'dock-file-src/dock-example.ts'); await settle(1000); await park(app) },
  'dock-explorer-search': async (app, fx) => { await panel('explorer')(app, fx); await app.getByTestId('dock-file-search').fill('preview'); await settle(1000); await park(app) },
  'dock-resize': async (app, fx) => { await panel('agents')(app, fx); await app.getByTestId('dock-resize').dragBy(60, 0); await settle(600); await park(app) },
  'dock-note-editor': async (app, fx) => {
    await go(app, 'notes')
    await app.getByTestId('notes-search').fill('Design review notes')
    await settle(500)
    await click(app, `note-card-${fx.notes['Design review notes']}`)
    await app.getByTestId('note-editor').waitFor()
    await settle(1000)
    await park(app)
  },
  ...Object.fromEntries(['agents', 'activity', 'changes', 'explorer', 'review', 'terminal', 'artifacts', 'notes', 'tasks', 'preview'].map(tab => [`dock-${tab}`, panel(tab)])),
  'dock-add-menu': async (app, fx) => { await open(app, fx); await click(app, 'dock-add'); await park(app) },
}

export const entries = {
  'dock-preview': { entry: 'visual/screens/dock.entry.tsx', env: { DOCK_VISUAL_STATE: 'servers' } },
  'dock-narrow': { entry: 'src/main.tsx', env: { KYBERN_WINDOW_SIZE: '980x820' } },
  'dock-live': { entry: 'scripts/dock2-fixture.tsx', env: { DOCK2_LIVE: '1' } },
  'dock-preview-opened': { entry: 'visual/screens/dock.entry.tsx', env: { DOCK_VISUAL_STATE: 'opened' } },
  'dock-preview-mini': { entry: 'visual/screens/dock.entry.tsx', env: { DOCK_VISUAL_STATE: 'mini' } },
  'dock-diff-file': { entry: 'visual/screens/dock.entry.tsx', env: { DOCK_VISUAL_STATE: 'diff' } },
}
