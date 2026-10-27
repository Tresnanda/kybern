// What the Get-started card knows: whether it exists (the flow ended on this environment), what it still has to offer
// (`needs`), whether the user hid or collapsed it, and what the machine says about each item (`facts`). The card shows on this
// Mac only: the CLI, notifications and Computer use are facts about the machine the window runs on.
//
// Persisted per environment in `gpuix-ui.json` (`shell/persist.ts`). An install that finished onboarding before the card
// existed has no record, so it never gets one.
import { cliStatus } from '../platform/cli.ts'
import { notifications } from '../native/notifications.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { getClient } from '../state.ts'
import { createStore } from './store.ts'
import { UNKNOWN, glideDistance, type Facts, type Needs } from './getStarted.ts'
import { onImportFinished } from './projectsStore.ts'

const KEY = 'kybern.getstarted'
interface Saved {
  needs: Needs
  hidden: boolean
  /** `null`: never chosen, so the window's height decides. */
  expanded: boolean | null
  importDone: boolean
}

interface State extends Saved {
  /** The flow ended here, so a card exists (until it is hidden or complete). */
  exists: boolean
  facts: Facts
  /** The first read of the machine has finished: ticks before it are not news. */
  factsReady: boolean
  /** The Draft's glide: bumps when the card changes height; `from` is how far the Draft starts from where it ends (down is +). */
  glide: { generation: number; from: number }
}

const fresh = (): State => ({ exists: false, needs: { agent: false, import: false }, hidden: false, expanded: null, importDone: false, facts: UNKNOWN, factsReady: false, glide: { generation: 0, from: 0 } })
function hydrate(): State {
  const saved = load<Saved | null>(KEY, null)
  return saved ? { ...fresh(), ...saved, exists: true } : fresh()
}

export const getStarted = createStore<State>(hydrate())
export const useGetStarted = getStarted.use

function persist() {
  const s = getStarted.get()
  if (!s.exists) return
  save(KEY, { needs: s.needs, hidden: s.hidden, expanded: s.expanded, importDone: s.importDone } satisfies Saved)
}

/** The flow ended: the card exists from now on, offering what is left. */
export function startGetStarted(needs: Needs) {
  getStarted.set({ exists: true, needs, hidden: false, expanded: null, importDone: false })
  persist()
  void refreshFacts()
}

/** The Draft moves by 13/20 of the card's change in height (`glideDistance`): it starts that far from home and settles. */
const glideFor = (change: number) => ({ generation: getStarted.get().glide.generation + 1, from: -glideDistance(change) })

/** `change`: how much taller (+) or shorter (-) the card's slot becomes, so the Draft glides in the same update. */
export function setExpanded(expanded: boolean, change = 0) {
  getStarted.set({ expanded, glide: glideFor(change) })
  persist()
}

export function hideCard(change = 0) {
  getStarted.set({ hidden: true, glide: glideFor(change) })
  persist()
}

function markImportDone() {
  if (getStarted.get().importDone) return
  getStarted.set({ importDone: true })
  persist()
}
// An import with chats finishing, from the card's Import or the flow's own, ticks the item.
onImportFinished((summary) => { if (getStarted.get().exists && summary.mode !== 'none' && summary.chats > 0) markImportDone() })

onEnvironmentChange(() => { getStarted.reset(hydrate()) })

// ─── Facts ────────────────────────────────────────────────────────────────

async function read<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch { return undefined }
}

let reading = false
/** Read the machine again. One read at a time; each fact lands as it arrives, so one slow answer never holds the others. */
export async function refreshFacts(): Promise<void> {
  const s = getStarted.get()
  if (reading || !s.exists || s.hidden || !activeEnvironment().local) return
  reading = true
  const client = getClient()
  const put = (patch: Partial<Facts>) => getStarted.set((state) => ({ facts: { ...state.facts, ...patch } }))
  try {
    await Promise.all([
      read(() => cliStatus()).then((status) => { if (status) put({ cli: !!status.resolved || (status.installed && status.target_on_path) }) }),
      read(() => notifications.status()).then((status) => put({ notifications: !status || status === 'unsupported' ? 'unsupported' : status === 'granted' ? 'granted' : 'pending' })),
      client && read(() => client.call('access.tokens.list', {})).then((list) => { if (list) put({ phone: list.tokens.some((t) => !t.revoked && t.label !== 'bootstrap') }) }),
      process.platform === 'darwin' && client
        ? read(() => client.call('computer.status', {})).then((status) => put({ computer: !status || !status.supported ? 'unsupported' : status.ready ? 'ready' : 'pending' }))
        : undefined,
    ])
  } finally {
    reading = false
    getStarted.set({ factsReady: true })
  }
}
