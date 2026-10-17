import { park, settle, type Step } from '../screens.gpuix.ts'
import { open } from './conversation.gpuix.ts'
import { waitUntil, exists } from '../../scripts/shell3-lib.ts'
const pointerOpen: typeof open = async (app, fx, title) => {
  const ids = fx.extra.conversation!
  const id = `thread-${ids[title]}`
  if (!await app.getByTestId(id).count()) { const more = app.getByTestId(`more-${ids.__project}`); await more.hover(); await settle(180); await more.click() }
  const target=app.getByTestId(id)
  for(let attempt=0;attempt<30;attempt++){
    try{await target.hover();await settle(180);await target.click();break}
    catch(error){if(attempt===29)throw error;await app.mouse.wheel({x:180,y:600},0,-200);await settle(100)}
  }
  await waitUntil(exists(app, 'transcript-surface'), 15000, 'thread transcript')
}

/** Round-3 shell fixes: the transcript rail and markdown rhythm. */
export const screens: Record<string, Step> = {
  'shell3-rail': async (app, fx) => { await pointerOpen(app, fx, 'Long review thread'); await park(app) },
  'shell3-rail-hover': async (app, fx) => { await pointerOpen(app, fx, 'Long review thread'); await app.getByTestId('message-jump-4').hover(); await settle(900) },
  'shell3-spacing': async (app, fx) => { await pointerOpen(app, fx, 'Rich reply'); await park(app) },
}
