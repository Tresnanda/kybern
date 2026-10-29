// The new chat screen (ADE-62): "Let's work in" over the project as a large picker, the tray (Checkout and branch, plus an
// attached task) docked on the composer, and the pick-up (Continue, Up next) hanging 32 below the card. The headline, tray and
// composer are one block centred on 40 % of the pane (spacers 7 : 13); the pick-up is out of the flow, so it never moves the
// composer. Sending starts a thread (or the attached task's run), and the thread page carries the prompt and the composer
// into place (`draft/Morph.tsx`).
//
// Motion: the desktop's `t-stagger` entrance: the headline, the composer block and the pick-up rise 12 px over 500 ms,
// 70 ms apart. It plays once per mount, never on the launch mount; a mount from a keyboard shortcut (⌘N, ⌘[ / ⌘]) appears
// settled.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TaskItem, Thread } from '../../../packages/kybern-client/src/types.ts'
import { DraftComposer, useDraftTarget, type ComposerSnapshot } from './Composer.tsx'
import { selectDraft, useApp, usePaneAccess, usePaneCompact } from './state.ts'
import { useSpaceProjects } from './spaces/current.ts'
import { COLUMN, GUTTER } from './Transcript.tsx'
import { patchDraft } from './composer/store.ts'
import { LandingTray, landingTrayShown } from './composer/Tray.tsx'
import { Rise } from './motion/kit.tsx'
import { addWindowKeyHandler } from './nav/keys.ts'
import { openThread } from './nav/history.ts'
import { observeElementBounds, type LayoutRect } from './native/layout.ts'
import { useTasks } from './tasks/store.ts'
import { Headline } from './draft/Headline.tsx'
import { InstructionsOffer } from './draft/InstructionsOffer.tsx'
import { attachedForProject, continueThreads, MORPH_MAX_IMAGES, MORPH_MAX_LINES, pickupRowsFor, upNextTasks } from './draft/model.ts'
import { PickUp, type PickUpHandle } from './draft/PickUp.tsx'
import { clearAttachedTask, setLaunch, toggleAttachedTask, useAttachedTaskId, type ExitPaint } from './draft/store.ts'

/** The last window key press (`performance.now()`); never consumes the event. */
let lastKeyAt = -Infinity
addWindowKeyHandler(() => {
  lastKeyAt = performance.now()
  return false
})
let mounts = 0
/** Read once per mount, like the desktop's `useState(() => !isLaunching())`. */
function shouldEnter(): boolean {
  const launch = mounts++ === 0
  return !launch && performance.now() - lastKeyAt > 400
}

/** Headline to tray. */
const HEAD_GAP = 28
/** Card bottom to the pick-up. */
const PICKUP_GAP = 32
/** The pick-up box sits 8 inside the column, so row text lines up with the composer's text. */
const PICKUP_INSET = 8

export function Draft() {
  const pane = usePaneAccess()
  const renderer = useGpuixRequired()
  const compact = usePaneCompact()
  const coordinator = useApp((s) => s.draft.purpose === 'coordinator')
  const projects = useSpaceProjects()
  const { projectId, project, useWorktree, machine } = useDraftTarget()
  const list = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const [enter] = useState(shouldEnter)

  // ---- the pick-up's data ----
  const threads = useApp((s) => s.threads)
  const tasksById = useTasks((s) => s.tasks)
  const tasksReady = useTasks((s) => s.loaded)
  const recent = useMemo(() => continueThreads(threads, projectId), [threads, projectId])
  const upNext = useMemo(() => upNextTasks(Object.values(tasksById), projectId), [tasksById, projectId])
  const attachedId = useAttachedTaskId(pane.id)
  const attached = attachedForProject(attachedId ? tasksById[attachedId] : null, projectId)
  // A task that left this project (or the list) is detached.
  useEffect(() => { if (attachedId && !attached) clearAttachedTask(pane.id) }, [attachedId, attached, pane.id])

  // ---- geometry: rows that fit under the card, and whether the column is narrow ----
  const root = useRef<PublicInstance | null>(null)
  const block = useRef<PublicInstance | null>(null)
  const [rects, setRects] = useState<{ root: LayoutRect | null; block: LayoutRect | null }>({ root: null, block: null })
  useEffect(() => {
    const stops = (['root', 'block'] as const).flatMap((key) => {
      const node = key === 'root' ? root.current : block.current
      return node ? [observeElementBounds(renderer, { id: node.id }, (event) => setRects((old) => (sameRect(old[key], event.rect) ? old : { ...old, [key]: event.rect })))] : []
    })
    return () => stops.forEach((stop) => stop())
  }, [renderer])
  const rows = rects.root && rects.block ? pickupRowsFor(rects.root.y + rects.root.height, rects.block.y + rects.block.height) : 0
  const narrow = (rects.block?.width ?? COLUMN) < 600

  // ---- the composer's hooks into the screen ----
  const focusEditor = useRef<() => void>(() => {})
  const pickup = useRef<PickUpHandle | null>(null)
  const trayShown = landingTrayShown(projectId, attached)
  const pick = (id: string | null) => {
    patchDraft({ projectId: id, worktree: null, baseBranch: null })
    if (coordinator && id) selectDraft(id, 'coordinator')
  }
  const headline = (frozen: boolean) => <Headline projects={list} projectId={projectId} name={project?.name ?? null} coordinator={coordinator} onPick={pick} frozen={frozen} />
  const pickupView = (frozen: boolean, data: { recent: Thread[]; upNext: TaskItem[] } = { recent, upNext }) => (
    <PickUp
      threads={data.recent}
      tasks={data.upNext}
      tasksReady={tasksReady || frozen}
      attachedId={attached?.id ?? null}
      rows={rows}
      narrow={narrow}
      frozen={frozen}
      onOpen={(thread) => openThread(thread.id)}
      onToggleTask={(task) => { toggleAttachedTask(pane.id, task.id); focusEditor.current() }}
      onLeave={() => focusEditor.current()}
      handleRef={frozen ? undefined : (handle) => { pickup.current = handle }}
    />
  )
  const tray = (still: boolean) => <LandingTray projectId={projectId} useWorktree={useWorktree} task={attached} onRemoveTask={() => clearAttachedTask(pane.id)} still={still} remote={machine.remote && machine.chosen?.project ? { machineId: machine.chosen.machineId, project: machine.chosen.project } : undefined} />

  /** The send has its thread: record where everything was, in this page's coordinates, for the thread page to carry on. */
  const onLaunch = (threadId: string, snapshot: ComposerSnapshot | undefined) => {
    const origin = root.current ? renderer.getElementBounds?.(root.current.id) : null
    const blockRect = block.current ? renderer.getElementBounds?.(block.current.id) : null
    const card = snapshot?.card
    if (!origin || !snapshot || !card) return
    const local = (r: LayoutRect): LayoutRect => ({ x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height })
    const typed = snapshot.text.trim().length > 0
    // The bubble wraps at 563 pt instead of the editor's 704 and uses a 22.75 line, so lines grow by about 5 : 4.
    const bubbleLines = Math.ceil(snapshot.lines * 1.25)
    // An attached task becomes a token at the head of the message, so the bubble is not the editor's text: it fades.
    const flies = typed && !!snapshot.editor && !snapshot.scrolled && bubbleLines <= MORPH_MAX_LINES && !attached
    const images = snapshot.images.map((image) => ({ ...image, rect: local(image.rect) }))
    const frozen = { recent, upNext }
    setLaunch({
      paneId: pane.id,
      threadId,
      paneX: origin.x,
      paneY: origin.y,
      paneWidth: origin.width,
      paneHeight: origin.height,
      cardTop: card.y - origin.y,
      cardHeight: card.height,
      text: flies ? { value: snapshot.text, rect: local(snapshot.editor!), lines: snapshot.lines } : null,
      textFades: typed && !flies,
      textRect: snapshot.editor ? local(snapshot.editor) : null,
      textValue: snapshot.text,
      images,
      imagesFly: images.length > 0 && images.length <= MORPH_MAX_IMAGES && !attached,
      tray: trayShown ? tray(true) : null,
      exit: (paint) => (
        <DraftLayout
          gutter={compact ? 20 : GUTTER}
          headline={headline(true)}
          middle={<div style={{ height: blockRect?.height ?? card.height }} />}
          pickup={pickupView(true, frozen)}
          paint={paint}
          frozen
        />
      ),
      at: performance.now(),
    })
  }

  return (
    <DraftLayout
      rootRef={(node) => { root.current = node }}
      blockRef={(node) => { block.current = node }}
      gutter={compact ? 20 : GUTTER}
      enter={enter}
      headline={headline(false)}
      middle={<>
        {!coordinator && <InstructionsOffer project={project} />}
        <DraftComposer
          tray={trayShown ? tray(false) : undefined}
          extras={{
            task: attached,
            placeholder: attached ? `Add instructions, or send to start ${attached.key}` : undefined,
            onEmptyDown: () => pickup.current?.focusFirst() ?? false,
            focusRef: (focus) => { focusEditor.current = focus },
            onLaunch,
            onTaskSent: () => clearAttachedTask(pane.id),
          }}
        />
      </>}
      pickup={pickupView(false)}
    />
  )
}

const sameRect = (a: LayoutRect | null, b: LayoutRect | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * The screen's geometry, shared by the live screen and the send transition's frozen copy so both lay out identically: a
 * centred column, the block between 7 : 13 spacers, the pick-up hanging from the block's bottom outside the flow.
 */
function DraftLayout({ rootRef, blockRef, gutter, enter = false, headline, middle, pickup, paint, frozen = false }: {
  rootRef?: (node: PublicInstance | null) => void
  blockRef?: (node: PublicInstance | null) => void
  gutter: number
  enter?: boolean
  headline: ReactNode
  /** The tray and composer (or, frozen, a spacer of their height). */
  middle: ReactNode
  pickup: ReactNode
  /** The frozen copy's exits. */
  paint?: ExitPaint
  frozen?: boolean
}) {
  return (
    <div
      ref={rootRef}
      testId={frozen ? 'draft-exit' : 'draft'}
      style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: gutter, paddingRight: gutter, ...(frozen ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' } : {}) }}
    >
      <div style={{ flexGrow: 7, flexBasis: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', flexShrink: 0 }}>
        <Rise kind="stagger" index={0} play={enter} paint={paint?.headline} style={{ alignItems: 'center', width: '100%', maxWidth: COLUMN }}>
          {headline}
        </Rise>
        <div ref={blockRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: COLUMN, marginTop: HEAD_GAP, position: 'relative' }}>
          <Rise kind="stagger" index={1} play={enter} style={{ alignItems: 'center', width: '100%' }}>
            {middle}
          </Rise>
          {/* Out of the flow: a zero-height anchor under the card, so loading, empty and one-group states never move the block. */}
          <div style={{ position: 'relative', width: '100%', height: 0 }}>
            <div style={{ position: 'absolute', left: PICKUP_INSET, right: PICKUP_INSET, top: PICKUP_GAP, display: 'flex', flexDirection: 'column' }}>
              <Rise kind="stagger" index={2} play={enter} paint={paint?.pickup}>
                {pickup}
              </Rise>
            </div>
          </div>
        </div>
      </div>
      <div style={{ flexGrow: 13, flexBasis: 0 }} />
    </div>
  )
}
