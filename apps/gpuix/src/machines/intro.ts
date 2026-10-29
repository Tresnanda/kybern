// The machine network's intro (ADE-86): the network is off until the user turns it on, so the first time this device reaches a
// daemon that has it, off, a short dialog says what it is and offers to turn it on. Either answer is remembered for this user
// (a small file in the client config dir, like `notice.ts`), so it never comes back by itself; Settings → Machines reopens it.
// It waits for the first-run onboarding to end and never shows while the network is already on.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { writeAllowed } from '../shell/persist.ts'
import { createStore } from '../onboarding/store.ts'

export const INTRO_FILE = 'network-intro.json'

/** How the intro was answered: turned on from it, "Not now", or the network was already on when it would have shown. */
export type IntroChoice = 'on' | 'later' | 'already-on'

export interface IntroInput {
  /** This user answered it before. */
  decided: boolean
  /** The daemon's `network.status`: `null` until it answers, `false` when it has no network. */
  status: Pick<NetworkStatus, 'enabled'> | null | false
  /** The first-run flow is on screen or handing off. */
  onboarding: boolean
}
/** What to do now: show it, remember that the network was on already, wait for a later look, or nothing ever. */
export type IntroAction = 'show' | 'record-on' | 'wait' | 'none'

export function introAction({ decided, status, onboarding }: IntroInput): IntroAction {
  if (decided) return 'none'
  // An older daemon without the network: nothing to turn on yet. Asked again after an update.
  if (status === false) return 'none'
  if (status === null) return 'wait'
  if (status.enabled) return 'record-on'
  return onboarding ? 'wait' : 'show'
}

export function introChoice(dir: string): IntroChoice | null {
  try {
    const choice = (JSON.parse(readFileSync(path.join(dir, INTRO_FILE), 'utf8')) as { choice?: string }).choice
    return choice === 'on' || choice === 'later' || choice === 'already-on' ? choice : null
  } catch { return null }
}

export function recordIntroChoice(dir: string, choice: IntroChoice) {
  const file = path.join(dir, INTRO_FILE)
  if (!writeAllowed(file)) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ choice, at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(temp, file)
  } catch { /* a read-only config folder only means it is offered again next time */ }
}

/** Tailscale as the requirement line says it. */
export type TailscaleNote = 'running' | 'stopped' | 'missing' | 'unknown'
export function tailscaleNote(tailscale: { installed: boolean; running: boolean } | undefined): TailscaleNote {
  if (!tailscale) return 'unknown'
  if (!tailscale.installed) return 'missing'
  return tailscale.running ? 'running' : 'stopped'
}

/** `intro`: what it is and Turn on. `on`: it is on, and what happens next. */
export type IntroStep = 'intro' | 'on'
interface IntroState {
  open: boolean
  step: IntroStep
  /** Opened from Settings → Machines ("What is this?"): closing it records nothing. */
  fromSettings: boolean
}
export const intro = createStore<IntroState>({ open: false, step: 'intro', fromSettings: false })
export const useIntro = intro.use

export const openIntro = (fromSettings: boolean, step: IntroStep = 'intro') => intro.set({ open: true, step, fromSettings })
export const closeIntro = () => intro.set({ open: false })
