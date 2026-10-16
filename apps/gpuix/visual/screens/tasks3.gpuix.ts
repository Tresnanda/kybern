// Tasks round 3: the board's quick-add card and the task page edited in place.
import { click, go, park, settle, type Step } from '../screens.gpuix.ts'

const board: Step = async (app) => { await go(app, 'tasks'); await click(app, 'task-view-board'); await settle(500) }
const detail: Step = async (app, fx) => { await go(app, 'tasks'); await click(app, `task-drag-${fx.tasks['Ship notes image blocks']}`); await settle(1000) }

export const screens: Record<string, Step> = {
  'tasks3-board-quick-add': async (app, fx) => { await board(app, fx); await app.getByTestId('task-column-inbox').hover(); await settle(300); await click(app, 'task-board-add-inbox'); await settle(500); await park(app) },
  'tasks3-board-quick-typed': async (app, fx) => { await board(app, fx); await app.getByTestId('task-column-inbox').hover(); await settle(300); await click(app, 'task-board-add-inbox'); await settle(500); await app.getByTestId('task-quick-title').fill('Write the release notes'); await settle(400); await park(app) },
  'tasks3-detail-title-focus': async (app, fx) => { await detail(app, fx); await click(app, 'task-title'); await settle(500); await park(app) },
  'tasks3-detail-desc-focus': async (app, fx) => { await detail(app, fx); await click(app, 'task-desc'); await settle(600); await park(app) },
  'tasks3-detail-criteria-hover': async (app, fx) => { await detail(app, fx); await app.getByTestId('task-criterion-row-2').hover(); await settle(400) },
}
