import { click, park, settle, type Step } from '../screens.gpuix.ts'
const home = async (app: Parameters<Step>[0]) => { await app.getByTestId('rail-home').click(); await settle(800) }
export const screens: Record<string, Step> = {
  'shell-home': async (app) => { await home(app); await park(app) },
  'shell-sidebar-collapsed': async (app) => { await home(app); await app.getByTestId('sidebar-toggle').click(); await settle(700); await park(app) },
  'shell-sidebar-hover': async (app) => { await home(app); await app.mouse.move({ x: 130, y: 354 }); await settle(500) },
  'shell-new-chat-hover': async (app) => { await home(app); await app.mouse.move({ x: 116, y: 147 }); await settle(500) },
}

/** Fixture entry: the real app with the close guard raised over two busy threads (`KYBERN_PREVIEW_CLOSE_GUARD`). */
export const entries = { 'close-guard': { entry: 'src/main.tsx', env: { KYBERN_PREVIEW_CLOSE_GUARD: '1' } } }
screens['close-guard'] = async (app) => { await settle(1500); await park(app) }

const thread: Step = async (app, fx) => { await click(app, `thread-${fx.extra.settings!.threadId}`); await settle(1200) }
screens['thread-header'] = async (app, fx) => { await thread(app, fx); await park(app) }
screens['env-panel'] = async (app, fx) => { await thread(app, fx); await click(app, 'environment-toggle'); await settle(900); await park(app) }

// Chrome raised by `src/shell/preview.ts` (`KYBERN_PREVIEW`).
for (const name of ['banner-reconnecting', 'banner-failed', 'toasts']) {
  ;(entries as Record<string, { entry: string; env?: Record<string, string> }>)[name] = { entry: 'src/main.tsx', env: { KYBERN_PREVIEW: name } }
  screens[name] = async (app) => { await settle(2200); await park(app) }
}

screens['split-empty'] = async (app, fx) => { await thread(app, fx); await app.getByTestId('app-ready').press('cmd-\\'); await settle(1200); await park(app) }

screens['split-two'] = async (app, fx) => { await screens['split-empty']!(app, fx); await click(app, `thread-${fx.extra.dock!.thread}`); await settle(1500); await park(app) }

// Drag the "Dock visual review" row over the right half of the open thread: the drop overlay.
screens['split-drop'] = async (app, fx) => {
  await thread(app, fx)
  const from = { x: 130, y: 413 }
  await app.mouse.move(from); await app.mouse.down(from)
  for (const x of [150, 200, 400, 700, 1000]) await app.mouse.move({ x, y: 420 }, { pressedButton: 0 })
  await settle(900)
}
