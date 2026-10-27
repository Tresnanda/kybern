// Where the first-run flow is: open or closed, which scene, which way it last moved, and how it ended. The completion mark is
// per environment (`shell/persist.ts`, beside the sidebar width), so a second machine gets its own first run.
import { load, save } from '../shell/persist.ts'
import { createStore } from './store.ts'
import { isReturningUser, shouldOnboard, type GateInput } from './model.ts'

export type SceneId = 'hero' | 'agents' | 'projects' | 'prefs'
export const SCENE_ORDER: readonly SceneId[] = ['hero', 'agents', 'projects', 'prefs']
export const SCENE_TITLE: Record<Exclude<SceneId, 'hero'>, string> = { agents: 'Agents', projects: 'Projects', prefs: 'Preferences' }

/** How the flow ended, which the app's first screen and the toast read. */
export type HandoffKind = 'built' | 'later' | 'free'
export interface Handoff {
  kind: HandoffKind
  /** The most recently imported project, for the Draft's heading. */
  projectId: string | null
  at: number
}

interface Flow {
  open: boolean
  scene: SceneId
  /** +1 forward, -1 back: which way the scenes push. */
  dir: 1 | -1
  /** The hero's one-time setpiece has played (it never replays on Back). */
  introPlayed: boolean
  /** Set when the flow ends: the real app is on screen and this run never opens it again. */
  finished: boolean
  /** The app shell is being mounted under the still-opaque welcome (its first frames hitch where nobody sees them). */
  releasing: boolean
  /** The shell mounted under the welcome has drawn and settled: the welcome may fade out now (`useShellReady` in `Handoff.tsx` sets it). */
  shellReady: boolean
  handoff: Handoff | null
}
const INITIAL: Flow = { open: false, scene: 'hero', dir: 1, introPlayed: false, finished: false, releasing: false, shellReady: false, handoff: null }
export const flow = createStore<Flow>(INITIAL)

const KEY = 'kybern.onboarding.completed'
export const FORCED = process.env.KYBERN_ONBOARDING === '1'
let completedCache: boolean | null = null
/** `onboarding.completed`: finished or skipped once on this environment. */
export const isCompleted = () => (completedCache ??= readCompleted())
function readCompleted() {
  // A pre-release build kept a Get-started card's state here; the card is gone, so is its key.
  save('kybern.getstarted', undefined)
  return load<boolean>(KEY, false)
}
export function markCompleted() {
  completedCache = true
  save(KEY, true)
}
/** Forget what was read: the next `isCompleted()` reads the mark of whichever environment is active then. */
export function resetCompleted() { completedCache = null }

export const useFlow = flow.use

/** The gate: should the flow be on screen now. Latched while open, so importing projects does not close it under the user. */
export function wantsOnboarding(input: Omit<GateInput, 'completed' | 'forced'>): boolean {
  const state = flow.get()
  if (state.open) return true
  if (state.finished) return false
  return shouldOnboard({ ...input, completed: isCompleted(), forced: FORCED })
}

/** Called from an effect when the gate first says yes. */
/** `KYBERN_ONBOARDING_SCENE=agents|projects|prefs`: start on a later scene (screenshots, development). */
const START = (['agents', 'projects', 'prefs'] as const).find((id) => id === process.env.KYBERN_ONBOARDING_SCENE)
export function openFlow() {
  if (!flow.get().open) flow.set({ ...INITIAL, open: true, ...(START ? { scene: START, introPlayed: true } : {}) })
}

/** A window with data and no mark belongs to a returning user: write the mark so an empty library later never brings the flow back. */
export function noteReturningUser(input: Pick<GateInput, 'projects' | 'threads'>) {
  if (!FORCED && !flow.get().open && isReturningUser({ ...input, completed: isCompleted() })) markCompleted()
}

export function go(scene: SceneId) {
  const state = flow.get()
  if (state.scene === scene) return
  flow.set({ scene, dir: SCENE_ORDER.indexOf(scene) >= SCENE_ORDER.indexOf(state.scene) ? 1 : -1 })
}
/**
 * Move from `from` to `to`, and only while `from` is the scene on screen. A button that is pressed twice (a double click, a key
 * repeat, a click and ⌘↵ together) moves once, and a late press from a scene that has already gone is ignored.
 */
export function goFrom(from: SceneId, to: SceneId): boolean {
  if (flow.get().scene !== from) return false
  go(to)
  return true
}

/**
 * The welcome fades out once the shell mounted under it has drawn and settled (`shellReady`), not after a fixed head start: the
 * mount and the app's first draws cost 20–35 ms each, and landing in the fade they were its stutter. If no frame is reported (a
 * hidden window, a stock addon) or the app keeps drawing, it fades after this long anyway.
 */
export const RELEASE_MAX_MS = 900

let releaseTimer: ReturnType<typeof setTimeout> | undefined
let stopReleaseWait: (() => void) | undefined

/** A different environment starts over: its own mark, its own first run (called when the active environment changes). */
export function resetFlow() {
  clearTimeout(releaseTimer)
  stopReleaseWait?.()
  stopReleaseWait = undefined
  resetCompleted()
  flow.reset(INITIAL)
}

/** End the flow: the app is mounted under the welcome, then the welcome dissolves into it. `finished` keeps it from reopening this run. */
export function finishFlow(kind: HandoffKind, projectId: string | null) {
  if (flow.get().releasing || flow.get().finished) return
  markCompleted()
  flow.set({ releasing: true, shellReady: false })
  const dissolve = () => {
    // Frame-cost runs (`scripts/onboarding-perf.ts`) split the handoff here: before it the welcome is still opaque.
    if (process.env.KYBERN_FRAME_COSTS) console.error('[kybern-onboarding] fade')
    clearTimeout(releaseTimer)
    stopReleaseWait?.()
    stopReleaseWait = undefined
    flow.set({ open: false, finished: true, releasing: false, shellReady: false, handoff: { kind, projectId, at: Date.now() } })
  }
  stopReleaseWait = flow.subscribe(() => { if (flow.get().shellReady) dissolve() })
  releaseTimer = setTimeout(dissolve, RELEASE_MAX_MS)
}
