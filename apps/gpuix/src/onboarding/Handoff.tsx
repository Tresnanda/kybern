// The way out (SPEC §6): Start building cross-fades the welcome out over the real app, as it is: the sidebar, the Draft with its
// composer and Continue list. Nothing in the app plays a special entrance. One toast says what the import is doing.
import { useEffect, useRef } from 'react'
import { patchDraft } from '../composer/store.ts'
import { onFrame } from '../native/frame.ts'
import { toast } from '../shell/toasts.tsx'
import { SkippedDialog, viewSkipped } from './SkippedDialog.tsx'
import { announce, importAnnouncements, START_MARK, useAnnouncement, type ImportMark } from './announce.ts'
import { flow, useFlow } from './flow.ts'
import { count, noun } from './model.ts'
import { getImportSummary, projectsStore, type ImportSummary } from './projectsStore.ts'

/** "Set up later": nothing was set up, and the place to do it is Settings. */
export const LATER_TOAST = { title: 'You can finish setup later', description: 'Set up an agent anytime in Settings › Agent providers.' }

/** A frame later than this is a hitch: the app is still drawing its first content (text shaped for the first time, lists landing). */
const HITCH_MS = 24
/** How long the app must draw without a hitch before the welcome starts to fade. */
const QUIET_MS = 150

/**
 * Called by the window's workspace. While the shell is mounted under the still-opaque welcome (`releasing`), report when it has
 * settled, so the welcome fades over an app that is already still. Its first draws (the sidebar and the Draft shaping their text
 * for the first time) cost 18–35 ms each; landing in the fade they were the handoff's stutter. Ready once two frames have drawn
 * and none was late for `QUIET_MS`; `finishFlow` caps the wait (`RELEASE_MAX_MS`).
 */
export function useShellReady() {
  const releasing = useFlow((s) => s.releasing)
  useEffect(() => {
    if (!releasing) return
    let frames = 0
    let last = 0
    let calm = 0
    const stop = onFrame((now) => {
      frames++
      if (last && now - last > HITCH_MS) calm = now
      if (!calm) calm = now
      last = now
      if (frames >= 2 && now - calm >= QUIET_MS) { stop(); flow.set({ shellReady: true }) }
    })
    return stop
  }, [releasing])
}

// ─── The toast ────────────────────────────────────────────────────────────

const TOAST = 'onboarding-import'
function sentence(s: ImportSummary) {
  const skipped = s.skipped > 0 ? ` ${count(s.skipped, 'chat')} ${noun(s.skipped, 'was', 'were')} skipped.` : ''
  return `${count(s.chats, 'chat')} ${noun(s.chats, 'is', 'are')} in your sidebar.${skipped}`
}

/** The import toast for the summary as it is now: progress while it runs, the summary once it ends. Returns whether it is still running. */
function showImportToast(s: ImportSummary): boolean {
  if (s.phase === 'running') {
    toast('Importing your chats', { id: TOAST, description: `${s.doneProjects} of ${count(s.projects, 'project')} done. You can start working now.`, progress: s.totalChats > 0 ? s.chats / s.totalChats : s.projects ? s.doneProjects / s.projects : 0, duration: Infinity })
    return true
  }
  if (s.phase === 'done') {
    if (s.mode === 'none') toast.success(`Added ${count(s.projects, 'project')}`, { id: TOAST, duration: 7000 })
    else toast.success(`Imported ${count(s.projects, 'project')}`, { id: TOAST, description: sentence(s), duration: s.skipped ? Infinity : 7000, ...(s.skipped ? { action: { label: 'View skipped', onClick: viewSkipped } } : {}) })
  }
  return false
}

/** The live region: a screen reader hears each announcement once (`announce.ts`). Zero-size and transparent; it takes no room. */
function Announcer() {
  const { message } = useAnnouncement((s) => s)
  return <div testId="onboarding-announcer" role="status" aria-live="polite" aria-label={message} style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
}

/** Mounted once in the app: the toast that follows the import and morphs into its summary, the free chat's draft target, the skipped-chats dialog, and the announcements. */
export function HandoffController() {
  const handoff = useFlow((s) => s.handoff)
  const at = handoff?.at ?? 0
  const kind = handoff?.kind
  /** The toast follows the import job on its own once the flow has ended, whatever happens to `handoff` after. */
  const following = useRef(false)
  useEffect(() => { if (kind === 'free') patchDraft({ projectId: null }) }, [at, kind])
  useEffect(() => {
    if (!at || !kind) return
    if (kind === 'later') { toast(LATER_TOAST.title, { id: TOAST, description: LATER_TOAST.description, duration: 8000 }); return }
    if (kind === 'free') return
    following.current = showImportToast(getImportSummary()) || getImportSummary().phase === 'none'
  }, [at, kind])
  useEffect(() => {
    let last = getImportSummary()
    return projectsStore.subscribe(() => {
      const summary = projectsStore.get().summary
      if (summary === last) return
      last = summary
      if (following.current && !showImportToast(summary) && summary.phase === 'done') following.current = false
    })
  }, [])
  // Milestones for a screen reader: the import starting, each project settling, the import ending.
  useEffect(() => {
    let mark: ImportMark = START_MARK
    return projectsStore.subscribe(() => {
      const s = projectsStore.get()
      const out = importAnnouncements(mark, { phase: s.summary.phase, plan: s.plan, imports: s.imports, summary: s.summary })
      mark = out.mark
      if (out.lines.length > 0) announce(out.lines.join(' '))
    })
  }, [])
  return <><SkippedDialog /><Announcer /></>
}
