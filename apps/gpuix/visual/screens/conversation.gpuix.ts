import path from 'node:path'
import { SCRATCH } from '../fixture.ts'
import { park, settle, type Step } from '../screens.gpuix.ts'

const conv = (fx: { extra?: Record<string, Record<string, string>> }) => fx.extra?.conversation ?? {}
export async function open(app: Parameters<Step>[0], fx: Parameters<Step>[1], title: string) {
  if (title === 'Review cancellation') { await open(app, fx, 'Native subagents'); await app.getByTestId(`subagent-open-${conv(fx as never)[title]}`).click(); await settle(1000); return }
  if (!await app.getByTestId(`thread-${conv(fx as never)[title]}`).count()) { await app.getByTestId(`more-${conv(fx as never).__project}`).click(); await settle(300) }
  const target = app.getByTestId(`thread-${conv(fx as never)[title]}`)
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await target.click(); break }
    catch (error) { if (attempt === 11) throw error; await app.mouse.wheel({ x: 180, y: 600 }, 0, -200); await settle(200) }
  }
  await settle(1500)
}

export const entries = { 'conversation-attachments': { entry: 'src/main.tsx', env: { KYBERN_GPUIX_ATTACH: path.join(SCRATCH, 'review-notes.txt') } } }
export const screens: Record<string, Step> = {
  'conversation-attachments': async (app, fx) => { await open(app, fx, 'Empty conversation'); await app.getByTestId('attachment-file1').waitFor({ timeoutMs: 10000 }); await park(app) },
  'conversation-disabled': async (app, fx) => { await open(app, fx, 'Empty conversation'); await app.getByTestId('send').hover(); await settle(1000) },
  'conversation-subagent-hover': async (app, fx) => { await open(app, fx, 'Native subagents'); await app.getByTestId(`subagent-open-${conv(fx as never)['Review cancellation']}`).hover(); await settle(1000) },
  'conversation-launches': async (app, fx) => { await open(app, fx, 'Subagent launches'); await park(app) },
  'conversation-status': async (app, fx) => { await open(app, fx, 'Context status'); await park(app) },
  'conversation-held': async (app, fx) => { await open(app, fx, 'Held review message'); await park(app) },
  'conversation-permissions': async (app, fx) => { await open(app, fx, 'Pending permissions'); await park(app) },
  'conversation-limit': async (app, fx) => { await open(app, fx, 'Usage recovery'); await park(app) },
  'conversation-queued': async (app, fx) => { await open(app, fx, 'Queued follow-ups'); await park(app) },
  'conversation-helpers': async (app, fx) => { await open(app, fx, 'Helper review'); await park(app) },
  'conversation-subagents': async (app, fx) => { await open(app, fx, 'Native subagents'); await park(app) },
  'conversation-subagent-page': async (app, fx) => { await open(app, fx, 'Review cancellation'); await park(app) },
  'conversation-approval': async (app, fx) => { await open(app, fx, 'Approve a command'); await park(app) },
  'conversation-secret': async (app, fx) => { await open(app, fx, 'Request a service key'); await park(app) },
  'conversation-brief': async (app, fx) => { await open(app, fx, 'Review project brief'); await park(app) },
  'conversation-settings': async (app, fx) => { await open(app, fx, 'Review coordinator settings'); await park(app) },
  'conversation-empty': async (app, fx) => { await open(app, fx, 'Empty conversation'); await park(app) },
  'conversation-short': async (app, fx) => { await open(app, fx, 'Short exchange'); await park(app) },
  'conversation-reference': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await app.getByTestId('composer').fill('@Release'); await settle(1000); await app.getByTestId('composer').press('enter'); await park(app) },
  'conversation-diff': async (app, fx) => { await open(app, fx, 'Inline file changes'); await app.getByTestId('edited-file-date.ts').click(); await settle(1000); await park(app) },
  'conversation-typing': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await app.getByTestId('composer').fill('Add a guard for null input.'); await park(app) },
  'conversation-completion': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await app.getByTestId('composer').fill('@'); await settle(1000); await park(app) },
  'conversation-model': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await app.getByTestId('model-picker').click(); await settle(1500); await park(app) },
  'conversation-transcript': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await park(app) },
}
