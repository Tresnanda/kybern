// The way out (SPEC §6): Start building dissolves the welcome into the real app. The shell comes in from 1.04, the Draft rises as
// it always does, four suggestion chips follow, the composer's placeholder types a few examples, and one toast says what the import
// is doing. Input is never blocked: the composer works from the first frame.
import type { PaintTransformProps } from '@gpuix/native/host'
import type { StyleDesc } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { patchDraft } from '../composer/store.ts'
import { PickerChip } from '../kit/PickerChip.tsx'
import { EASE } from '../motion/tokens.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { toast } from '../shell/toasts.tsx'
import { REDUCED_MOTION } from '../ui.tsx'
import { useAgents } from './agentsStore.ts'
import { LATER_TOAST, needsAfterFlow } from './getStarted.ts'
import { startGetStarted } from './getStartedStore.ts'
import { SkippedDialog, viewSkipped } from './SkippedDialog.tsx'
import { flow, useFlow } from './flow.ts'
import { count, noun } from './model.ts'
import { bez, In } from './motion.tsx'
import { getImportSummary, useImportSummary, type ImportSummary } from './projectsStore.ts'

/** How long after the handoff the app still counts as "just handed off" (a Draft mounted in this window plays the entrance). */
export const FRESH_MS = 3000
export const isFresh = () => { const h = flow.get().handoff; return !!h && Date.now() - h.at < FRESH_MS }

/** The app shell scales in from 1.04 over 900 ms under the dissolving welcome. */
export function ShellEntrance({ children, style }: { children: ReactNode; style?: StyleDesc }) {
  const at = useFlow((s) => s.handoff?.at ?? 0)
  const [live, setLive] = useState(false)
  const seen = useRef(at)
  if (seen.current !== at) { seen.current = at; if (at) setLive(true) }
  useEffect(() => {
    if (!live) return
    const timer = setTimeout(() => setLive(false), 1200)
    return () => clearTimeout(timer)
  }, [live, at])
  const run = live && PATCHED_NATIVE
  return (
    <div
      paintTransform={run ? (REDUCED_MOTION ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, ease: bez(EASE.out) }, generation: at } : { initial: { scale: 1.04, opacity: 0.4 }, animate: { scale: 1, opacity: 1 }, transition: { duration: 0.9, ease: bez(EASE.out) }, generation: at }) : undefined}
      style={style}
    >
      {children}
    </div>
  )
}

/** SPEC §6.2: sidebar rows slide in from -10 px, 45 ms apart from 260 ms, for about the first twelve. */
export const SLIDE = { from: -10, start: 0.26, step: 0.045, rows: 12, duration: 0.45 } as const
const HIDDEN = { opacity: 0, translateX: SLIDE.from }
const REST_ROW = { opacity: 1, translateX: 0 }

/**
 * Wraps one of the sidebar's first rows. The shell mounts under the still-opaque welcome and the rows wait there, hidden;
 * when the handoff starts (`at`) they play, `index` places each in the sequence. A row that mounts once the handoff is under
 * way slides in on its own clock. Anywhere else (a normal launch, a row scrolled into view later) it is a plain wrapper.
 */
export function HandoffSlide({ index, children }: { index: number; children: ReactNode }) {
  const at = useFlow((s) => s.handoff?.at ?? 0)
  const releasing = useFlow((s) => s.releasing)
  const bornAt = useRef(at)
  const live = PATCHED_NATIVE && index < SLIDE.rows && (releasing || (at > 0 && Date.now() - at < FRESH_MS))
  const reduced = REDUCED_MOTION
  const paint: PaintTransformProps | undefined = !live ? undefined : at === 0
    ? { initial: false, animate: reduced ? { opacity: 0 } : HIDDEN, transition: { duration: 0 }, retain: true }
    : {
      initial: bornAt.current === 0 ? false : reduced ? { opacity: 0 } : HIDDEN,
      animate: reduced ? { opacity: 1 } : REST_ROW,
      transition: reduced ? { duration: 0.15, ease: bez(EASE.out) } : { duration: SLIDE.duration, delay: SLIDE.start + index * SLIDE.step, ease: bez(EASE.out) },
      generation: at,
      retain: true,
    }
  return <div paintTransform={paint} style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
}

const FOLDER = ['Explain how this repo is structured', 'Find a bug worth fixing', 'Set up the dev environment', 'Review my latest changes']
const FREE = ['Explain a concept I’m learning', 'Write a shell script for me', 'Help me read an error message', 'Plan a small project']

/** Four chips under the composer that fill it when pressed. Only right after the flow, and gone once one is used. */
export function HandoffSuggestions({ free, fill }: { free: boolean; fill: (text: string) => void }) {
  const handoff = useFlow((s) => s.handoff)
  const [fresh] = useState(isFresh)
  if (!handoff || !fresh) return null
  const list = free ? FREE : FOLDER
  return (
    <div testId="onboarding-suggestions" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingTop: 14, maxWidth: 470 }}>
      {list.map((text, i) => (
        <In key={text} delay={0.78 + i * 0.08} y={12} blur={2} duration={0.5}>
          <PickerChip chevron={false} testId={`suggestion-${i}`} onClick={() => { fill(text); flow.set({ handoff: null }) }}>{text}</PickerChip>
        </In>
      ))}
    </div>
  )
}

const EXAMPLES = ['Fix the flaky login test', 'Explain how the importer groups chats by repo', 'Add a dark mode toggle to Settings']

/**
 * The composer's placeholder types a few examples, ~40 ms a character, holds 1.7 s and deletes at 14 ms, then returns to the
 * usual one (`undefined`). Stops at the first key press. Runs only right after the flow, never under Reduce Motion.
 */
export function useTypedPlaceholder(active: boolean): string | undefined {
  const [text, setText] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!active || REDUCED_MOTION) return
    let live = true
    const timers: ReturnType<typeof setTimeout>[] = []
    const wait = (ms: number) => new Promise<void>((resolve) => { timers.push(setTimeout(resolve, ms)) })
    const stop = addWindowKeyHandler(() => { live = false; setText(undefined); return false })
    void (async () => {
      await wait(1100)
      for (const example of EXAMPLES) {
        for (let i = 1; i <= example.length && live; i++) { setText(example.slice(0, i)); await wait(40) }
        if (!live) return
        await wait(1700)
        for (let i = example.length - 1; i >= 0 && live; i--) { setText(example.slice(0, i) || ' '); await wait(14) }
      }
      if (live) setText(undefined)
    })()
    return () => { live = false; stop(); timers.forEach(clearTimeout); setText(undefined) }
  }, [active])
  return text
}

// ─── The toast ────────────────────────────────────────────────────────────

const TOAST = 'onboarding-import'
function sentence(s: ImportSummary) {
  const skipped = s.skipped > 0 ? ` ${count(s.skipped, 'chat')} ${noun(s.skipped, 'was', 'were')} skipped.` : ''
  return `${count(s.chats, 'chat')} ${noun(s.chats, 'is', 'are')} in your sidebar.${skipped}`
}

/** Mounted once in the app: the toast that follows the import and morphs into its summary, the free chat's draft target, the Get-started card's start, and the skipped-chats dialog. */
export function HandoffController() {
  const handoff = useFlow((s) => s.handoff)
  const summary = useImportSummary()
  const at = handoff?.at ?? 0
  const kind = handoff?.kind
  // Read live so the card knows, when the flow ends, whether an agent was ready.
  const ready = useAgents().ready.length > 0
  const readyNow = useRef(ready)
  readyNow.current = ready
  useEffect(() => { if (kind === 'free') patchDraft({ projectId: null }) }, [at, kind])
  useEffect(() => {
    // The card starts when a whole run ends; coming back from its Import button changes nothing about it.
    if (!at || !kind || flow.get().only) return
    const s = getImportSummary()
    startGetStarted(needsAfterFlow({ kind, agentReady: readyNow.current, importPhase: s.phase, importMode: s.mode }))
  }, [at, kind])
  useEffect(() => {
    if (!at || !kind) return
    if (kind === 'later') { toast(LATER_TOAST.title, { id: TOAST, description: LATER_TOAST.description, duration: 8000 }); return }
    if (kind === 'free') return
    const s = getImportSummary()
    if (s.phase === 'running') {
      toast('Importing your chats', { id: TOAST, description: `${s.doneProjects} of ${count(s.projects, 'project')} done. You can start working now.`, progress: s.totalChats > 0 ? s.chats / s.totalChats : s.projects ? s.doneProjects / s.projects : 0, duration: Infinity })
    } else if (s.phase === 'done') {
      if (s.mode === 'none') toast.success(`Added ${count(s.projects, 'project')}`, { id: TOAST, description: 'Import their chats anytime from each project’s menu.', duration: 7000 })
      else toast.success(`Imported ${count(s.projects, 'project')}`, { id: TOAST, description: sentence(s), duration: s.skipped ? Infinity : 7000, ...(s.skipped ? { action: { label: 'View skipped', onClick: viewSkipped } } : {}) })
    }
  }, [at, kind, summary.phase, summary.doneProjects, summary.chats, summary.skipped])
  return <SkippedDialog />
}
