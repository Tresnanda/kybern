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
  handoff: Handoff | null
}
const INITIAL: Flow = { open: false, scene: 'hero', dir: 1, introPlayed: false, finished: false, handoff: null }
export const flow = createStore<Flow>(INITIAL)

const KEY = 'kybern.onboarding.completed'
export const FORCED = process.env.KYBERN_ONBOARDING === '1'
let completedCache: boolean | null = null
/** `onboarding.completed`: finished or skipped once on this environment. */
export const isCompleted = () => (completedCache ??= load<boolean>(KEY, false))
export function markCompleted() {
  completedCache = true
  save(KEY, true)
}
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
export const next = () => { const i = SCENE_ORDER.indexOf(flow.get().scene); const to = SCENE_ORDER[Math.min(SCENE_ORDER.length - 1, i + 1)]; if (to) go(to) }
export const back = () => { const i = SCENE_ORDER.indexOf(flow.get().scene); const to = SCENE_ORDER[Math.max(0, i - 1)]; if (to) go(to) }

/** End the flow: the app comes in under it. `finished` keeps it from reopening this run (a forced run included). */
export function finishFlow(kind: HandoffKind, projectId: string | null) {
  markCompleted()
  flow.set({ open: false, finished: true, handoff: { kind, projectId, at: Date.now() } })
}
