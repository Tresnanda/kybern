import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)
export const open = async (p, title) => {
  if (title === 'Review cancellation') { await open(p, 'Native subagents'); await p.getByText(title, { exact: true }).first().click(); await settle(p, 1000); return }
  const slot = process.env.GPUIX_VISUAL_SLOT ?? createHash('sha1').update(path.resolve(import.meta.dirname, '../../../..')).digest('hex').slice(0, 8)
  const scratch = process.env.VISUAL_SCRATCH ?? `/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}`
  const { port } = JSON.parse(readFileSync(path.join(scratch, 'conversation-proxy.json'), 'utf8'))
  const url = new URL(p.url()), socket = new URL(url.searchParams.get('url'))
  if (socket.port !== String(port)) { socket.port = String(port); url.searchParams.set('url', socket.toString()); await p.goto(url.toString()); await settle(p, 1200) }
 if (!await p.getByText(title, { exact: true }).count()) { await p.getByText(/^Show \d+ more$/).first().click(); await settle(p, 300) } await p.getByText(title, { exact: true }).first().click(); await settle(p, 1500) }

export const screens = {
  'conversation-attachments': async (p) => { await open(p, 'Empty conversation'); await p.locator('input[type=file]').setInputFiles({ name: 'review-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Review the date helper and add null coverage.\n') }); await settle(p, 1200); await park(p) },
  'conversation-disabled': async (p) => { await open(p, 'Empty conversation'); await p.getByRole('button', { name: 'Send message', exact: true }).hover({ force: true }); await settle(p, 1000) },
  'conversation-subagent-hover': async (p) => { await open(p, 'Native subagents'); await p.locator('[data-subagent-strip-title]').filter({ hasText: 'Review cancellation' }).hover(); await settle(p, 1000) },
  'conversation-launches': async (p) => { await open(p, 'Subagent launches'); await park(p) },
  'conversation-status': async (p) => { await open(p, 'Context status'); await park(p) },
  'conversation-held': async (p) => { await open(p, 'Held review message'); await park(p) },
  'conversation-permissions': async (p) => { await open(p, 'Pending permissions'); await park(p) },
  'conversation-limit': async (p) => { await open(p, 'Usage recovery'); await park(p) },
  'conversation-queued': async (p) => { await open(p, 'Queued follow-ups'); await park(p) },
  'conversation-helpers': async (p) => { await open(p, 'Helper review'); await park(p) },
  'conversation-subagents': async (p) => { await open(p, 'Native subagents'); await park(p) },
  'conversation-subagent-page': async (p) => { await open(p, 'Review cancellation'); await park(p) },
  'conversation-approval': async (p) => { await open(p, 'Approve a command'); await park(p) },
  'conversation-secret': async (p) => { await open(p, 'Request a service key'); await park(p) },
  'conversation-brief': async (p) => { await open(p, 'Review project brief'); await park(p) },
  'conversation-settings': async (p) => { await open(p, 'Review coordinator settings'); await park(p) },
  'conversation-empty': async (p) => { await open(p, 'Empty conversation'); await park(p) },
  'conversation-short': async (p) => { await open(p, 'Short exchange'); await park(p) },
  'conversation-reference': async (p) => { await open(p, 'Date helper cleanup'); await p.locator('[contenteditable=true]').last().fill('@Release'); await settle(p, 1000); await p.keyboard.press('Enter'); await park(p) },
  'conversation-diff': async (p) => { await open(p, 'Inline file changes'); await p.getByRole('button', { name: 'Show changes to date.ts', exact: true }).click(); await settle(p, 1000); await park(p) },
  'conversation-typing': async (p) => { await open(p, 'Date helper cleanup'); await p.locator('[contenteditable=true]').last().fill('Add a guard for null input.'); await park(p) },
  'conversation-completion': async (p) => { await open(p, 'Date helper cleanup'); await p.locator('[contenteditable=true]').last().fill('@'); await settle(p, 1000); await park(p) },
  'conversation-model': async (p) => { await open(p, 'Date helper cleanup'); await p.getByRole('button', { name: /Change model and reasoning/ }).click(); await settle(p, 1500); await park(p) },
  'conversation-transcript': async (p) => { await open(p, 'Date helper cleanup'); await park(p) },
}
