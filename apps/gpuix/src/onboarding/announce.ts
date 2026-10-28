// What a screen reader is told while the flow runs. Visual changes (a tile settling, a bar filling) say nothing by themselves, so
// the few moments that matter are spoken once: an import starting, each project finishing, the import ending, and the default
// agent changing. Never a tick of progress. The text is pure (`announce.test.ts`); `Announcer` is the one live region.
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { createStore } from './store.ts'
import { AGENT_NAMES, count } from './model.ts'
import type { ImportSummary, RootImport } from './projects.ts'

const store = createStore<{ message: string; n: number }>({ message: '', n: 0 })
export const useAnnouncement = store.use
/** Say `message` through the live region. The same text twice in a row is still spoken again. */
export const announce = (message: string) => store.set((s) => ({ message, n: s.n + 1 }))

/** The state of an import as the announcer last saw it. */
export interface ImportMark { phase: ImportSummary['phase']; settled: ReadonlySet<string> }
export const START_MARK: ImportMark = { phase: 'none', settled: new Set() }

/** What changed since `mark`: the import starting, a project settling, the import ending. */
export function importAnnouncements(
  mark: ImportMark,
  now: { phase: ImportSummary['phase']; plan: readonly { root: string; name: string }[]; imports: Record<string, RootImport>; summary: ImportSummary },
): { mark: ImportMark; lines: string[] } {
  const lines: string[] = []
  const settled = new Set(mark.settled)
  if (now.phase === 'none') return { mark: START_MARK, lines }
  if (mark.phase === 'none') lines.push(`Importing ${count(now.plan.length, 'project')}.`)
  for (const { root, name } of now.plan) {
    const imp = now.imports[root]
    if (!imp || settled.has(root) || (imp.state !== 'done' && imp.state !== 'failed')) continue
    settled.add(root)
    const chats = imp.imported + imp.already_imported
    lines.push(imp.state === 'failed' ? `${name} couldn’t be imported.` : chats > 0 ? `${name} imported, ${count(chats, 'chat')}.` : `${name} added.`)
  }
  if (mark.phase !== 'done' && now.phase === 'done') {
    const s = now.summary
    lines.push(`Import finished. ${count(s.projects, 'project')}, ${count(s.chats, 'chat')}${s.skipped > 0 ? `, ${s.skipped} skipped` : ''}.`)
  }
  return { mark: { phase: now.phase, settled }, lines }
}

/** "Claude Code is now your default agent." */
export const defaultAgentAnnouncement = (kind: ProviderKind) => `${AGENT_NAMES[kind]} is now your default agent.`
