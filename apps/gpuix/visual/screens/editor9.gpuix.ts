// Editor lane (phase 2): the shared native editor on the Notes page and the task page.
import { click, go, park, settle, type Step } from '../screens.gpuix.ts'
import { readState } from '../fixture.ts'
import { resetSample } from './editor9-reset.mjs'

const open: Step = async (app, fx) => {
  const state = readState()!
  await resetSample(`ws://127.0.0.1:${state.port}/ws`, state.token)
  await go(app, 'notes')
  await click(app, 'notes-filter-all')
  await app.getByTestId('notes-search').fill('Editor sample')
  await settle(700)
  await click(app, `note-card-${fx.notes['Editor sample']}`)
  await settle(1200)
}
/** Into the body from the title, like a writer would. */
const into: Step = async (app, fx) => { await open(app, fx); await click(app, 'note-title'); await app.getByTestId('note-title').press('down'); await settle(300) }
const keys = async (app: Parameters<Step>[0], ...list: string[]) => { for (const k of list) await app.getByTestId('note-body').press(k); await settle(400) }
const detail: Step = async (app, fx) => { await go(app, 'tasks'); await click(app, `task-drag-${fx.tasks['Ship notes image blocks']}`); await settle(1000) }

export const screens: Record<string, Step> = {
  'editor9-note': async (app, fx) => { await open(app, fx); await park(app) },
  'editor9-note-end': async (app, fx) => { await into(app, fx); await keys(app, 'cmd-down'); await park(app) },
  'editor9-note-slash': async (app, fx) => { await into(app, fx); await keys(app, 'cmd-down', 'enter', '/'); await settle(400); await park(app) },
  'editor9-note-slash-query': async (app, fx) => { await into(app, fx); await keys(app, 'cmd-down', 'enter', '/', 'h', 'e'); await settle(400); await park(app) },
  'editor9-note-select': async (app, fx) => { await into(app, fx); await keys(app, 'shift-down', 'shift-down', 'shift-down'); await park(app) },
  'editor9-note-link': async (app, fx) => { await into(app, fx); await keys(app, 'down', 'end', 'left', 'left', 'left'); await settle(400); await park(app) },
  'editor9-desc-select': async (app, fx) => { await detail(app, fx); await click(app, 'task-desc-input'); await app.getByTestId('task-desc-input').press('cmd-down'); await app.getByTestId('task-desc-input').press('shift-alt-left'); await settle(600); await park(app) },
}
