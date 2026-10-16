import { park, settle, type Step } from '../screens.gpuix.ts'
import { open } from './conversation.gpuix.ts'

/** Round-3 shell fixes: the transcript rail and markdown rhythm. */
export const screens: Record<string, Step> = {
  'shell3-rail': async (app, fx) => { await open(app, fx, 'Long review thread'); await park(app) },
  'shell3-rail-hover': async (app, fx) => { await open(app, fx, 'Long review thread'); await app.getByTestId('message-jump-4').hover(); await settle(900) },
  'shell3-spacing': async (app, fx) => { await open(app, fx, 'Rich reply'); await park(app) },
}
