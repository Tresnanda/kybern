// The Get-started card's rules (v1 SPEC §9), pure: which items exist, when each ticks, and the words the header uses.
// `getStartedStore.ts` reads the facts from the machine; `GetStartedCard.tsx` draws the result.
import { count, noun } from './model.ts'
import type { HandoffKind } from './flow.ts'

export type ItemId = 'agent' | 'cli' | 'phone' | 'computer' | 'notifications' | 'import'
/** The order the card lists its items in. */
export const ITEM_ORDER: readonly ItemId[] = ['agent', 'cli', 'phone', 'computer', 'notifications', 'import']

/** What the flow left undone, fixed when it ends: an item for a thing that was already fine never appears. */
export interface Needs {
  agent: boolean
  import: boolean
}

/** What the machine says now. `null` is "not read yet": the item shows, unticked, so the list does not jump while it loads. */
export interface Facts {
  agentReady: boolean | null
  cli: boolean | null
  phone: boolean | null
  computer: 'ready' | 'pending' | 'unsupported' | null
  notifications: 'granted' | 'pending' | 'unsupported' | null
  /** A real import (with chats) has finished since the flow ended. */
  importDone: boolean
}
export const UNKNOWN: Facts = { agentReady: null, cli: null, phone: null, computer: null, notifications: null, importDone: false }

export interface Item {
  id: ItemId
  done: boolean
}

/**
 * How the flow ended decides what is left to do. An agent is wanted only when none was ready; import only when it was skipped
 * ("Set up later", a free chat, nothing picked) or when the user chose to bring in projects without their chats.
 */
export function needsAfterFlow(input: { kind: HandoffKind; agentReady: boolean; importPhase: 'none' | 'running' | 'done'; importMode: 'latest' | 'all' | 'none' }): Needs {
  const imported = input.kind === 'built' && input.importPhase !== 'none' && input.importMode !== 'none'
  return { agent: !input.agentReady, import: !imported }
}

/** The items to show, in order, with their tick. Computer use is macOS only, and an item the platform cannot offer is dropped. */
export function visibleItems(platform: NodeJS.Platform, needs: Needs, facts: Facts): Item[] {
  const shown: Record<ItemId, boolean> = {
    agent: needs.agent,
    cli: true,
    phone: true,
    computer: platform === 'darwin' && facts.computer !== 'unsupported',
    notifications: facts.notifications !== 'unsupported',
    import: needs.import,
  }
  const done: Record<ItemId, boolean> = {
    agent: facts.agentReady === true,
    cli: facts.cli === true,
    phone: facts.phone === true,
    computer: facts.computer === 'ready',
    notifications: facts.notifications === 'granted',
    import: facts.importDone,
  }
  return ITEM_ORDER.filter((id) => shown[id]).map((id) => ({ id, done: done[id] }))
}

export const doneCount = (items: readonly Item[]) => items.filter((i) => i.done).length
export const allDone = (items: readonly Item[]) => items.length > 0 && items.every((i) => i.done)

const NUMBER = new Intl.NumberFormat('en')
/** "1 of 5 done". */
export const progressLabel = (items: readonly Item[]) => `${NUMBER.format(doneCount(items))} of ${NUMBER.format(items.length)} done`

/** The card opens expanded unless the window is too short to hold it above the composer. */
export const EXPANDED_MIN_HEIGHT = 760
export const defaultExpanded = (windowHeight: number) => windowHeight >= EXPANDED_MIN_HEIGHT

/**
 * How far the Draft moves when the card changes height by `delta`. The Draft centres its block between 7 : 13 spacers in
 * the room the card leaves, so a block that is `delta` taller than the room it had moves down by 13/20 of it.
 */
export const GLIDE_SHARE = 13 / 20
export const glideDistance = (delta: number) => Math.round(delta * GLIDE_SHARE * 100) / 100

// ─── Copy ─────────────────────────────────────────────────────────────────

export interface ItemCopy {
  title: string
  description: string
  button: string
  /** The icon, as a key `GetStartedCard.tsx` maps to a glyph. */
  icon: 'agent' | 'terminal' | 'phone' | 'computer' | 'bell' | 'import'
}
export const ITEM_COPY: Record<ItemId, ItemCopy> = {
  agent: { title: 'Set up an agent', description: 'Install or sign in to Claude Code, Codex or another agent.', button: 'Set up', icon: 'agent' },
  cli: { title: 'Install the kybern command', description: 'Start and check on agents from any terminal.', button: 'Install', icon: 'terminal' },
  phone: { title: 'Pair your phone', description: 'Follow your agents and answer their questions away from your desk.', button: 'Pair', icon: 'phone' },
  computer: { title: 'Turn on Computer use', description: 'Let agents read and use apps on this Mac, with your approval.', button: 'Turn on', icon: 'computer' },
  notifications: { title: 'Allow notifications', description: 'Hear when an agent finishes, fails or needs you.', button: 'Allow', icon: 'bell' },
  import: { title: 'Import past chats', description: 'Bring your earlier agent sessions into your projects.', button: 'Import', icon: 'import' },
}

/** "Set up later" and the toast: where the unfinished things went. */
export const LATER_TOAST = { title: 'You can finish setup later', description: 'Set up an agent and import past chats from the Get started card on Home.' }

// ─── Skipped chats (v1 SPEC §6, "View skipped") ───────────────────────────

export interface SkippedChat { project: string; title: string; reason: string; detail: string }
export interface SkippedGroup { project: string; chats: SkippedChat[] }

/** "3 chats were skipped". */
export function skippedTitle(n: number): string {
  return `${count(n, 'chat')} ${noun(n, 'was', 'were')} skipped`
}

/** The skipped chats by project, projects in the order they first skipped one, chats in the order the daemon reported them. */
export function groupSkipped(skips: readonly SkippedChat[]): SkippedGroup[] {
  const groups = new Map<string, SkippedChat[]>()
  for (const skip of skips) {
    const list = groups.get(skip.project)
    if (list) list.push(skip)
    else groups.set(skip.project, [skip])
  }
  return [...groups].map(([project, chats]) => ({ project, chats }))
}

/** Skips beyond what the summary keeps in detail (it holds the latest 200), so the dialog can say so instead of undercounting. */
export const unlistedSkips = (total: number, listed: number) => Math.max(0, total - listed)
