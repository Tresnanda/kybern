// A run: everything the agent did between two pieces of narration, folded into one muted line ("› Edited 2 files ·
// ran 3 commands · read 4 files"), chevron first. While it runs the counts swap in place and the tail shimmers with
// the call in flight. Opened, each call is a verb and a chip on the tree: a file (icon well + name, opens a tab), a
// command (`$ bun test`, shows its output) or a query. Words: `workRun.ts`; grouping: `chunkRuns` (`lib/workChunks.ts`).
//
// Motion is paint-only and fresh-only: a new run fades and rises 4 px (`arrivalTransform`), members arriving in an open
// run do the same 65 ms apart while their connectors draw (`TreeGroup arrive`). History never animates; the key is
// the first block's, so a growing run never remounts. No height reveal: GPUIX has no analytic row heights.
import { memo, useMemo, useState } from 'react'
import { getFileIconName } from '../shared/lib/kit/fileIcons.ts'
import { toolLineCounts, toolTarget, type ToolTarget } from '../../../../packages/kybern-client/src/toolActivity.ts'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { menuFileIcons } from '../native/diff-file-icons.ts'
import { fileIconColors } from '../native/file-icon-colors.ts'
import { useGlass } from '../platform/glass.ts'
import { getClient, usePaneAccess } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { isImageFile, resolveWorkspaceFile, underWorkspace } from './fileLinks.ts'
import { ThreadImagePreview } from './ThreadImage.tsx'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { Collapse } from '../motion/kit.tsx'
import { arrivalTransform, ARRIVAL, markTreeOpen, TICK_GAP, TreeGroup, TreeItem, TreeLines, useTreeSlot, type TreeShape } from '../tree/Tree.tsx'
import { Chevron, destructive, fg, muted, TEXT } from './kit.tsx'
import { Shimmer, SwapOnChange, useFresh } from './motion.tsx'
import { isTaskActive, ToolPanel, toolView, WorkRow, type RowContext } from './rows.tsx'
import { reportError, useRowState, type ToolBlock } from './store.ts'
import { basename, runSummary } from '../../../../packages/kybern-client/src/workRun.ts'

/** The summary line: 13 px at 22 px, 2 px above and below. */
const LINE = 22
const PAD = 2
/** Where the run meets a parent's stem (the "Worked for" fold): the chevron's centre. */
export const RUN_ANCHOR = PAD + LINE / 2
/** The chevron's 16 px slot: its 12 px glyph is inset 2. */
export const RUN_TICK_END = 2 - TICK_GAP
/** The open run's stem: down from under the chevron. */
const RUN_STEM: TreeShape = { anchor: RUN_ANCHOR, below: { x: 8, from: RUN_ANCHOR + 6 + TICK_GAP } }
/** Members sit 22 px in; ticks stop short of the verb. */
const MEMBER_INSET = 22
const MEMBER_LINE = 24
const MEMBER_ANCHOR = 1 + MEMBER_LINE / 2

/** One summary row for a run of work (`chunkRuns`). */
export const WorkRunRow = memo(function WorkRunRow({ blocks, ctx, liveThinkingId = null, waiting = false }: { blocks: Block[]; ctx: RowContext; liveThinkingId?: string | null; /** The live turn's newest work, with nothing in flight: the tail reads "thinking". */ waiting?: boolean }) {
  const t = useTheme()
  const first = blocks[0]!
  const [open, setOpen] = useRowState(`group:${first.id}`, false)
  const summary = useMemo(() => runSummary(blocks, liveThinkingId, waiting), [blocks, liveThinkingId, waiting])
  const tree = useTreeSlot()
  // Its own entrance only outside an opening group (whose stagger it then follows), and only when it just arrived.
  const fresh = useFresh(first.at)
  const [enter] = useState(() => (fresh && !tree.inTree ? arrivalTransform(ARRIVAL.first) : undefined))
  const tone = muted(t)
  return (
    <div paintTransform={tree.rise ?? enter} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: PAD, paddingBottom: PAD, minWidth: 0 }}>
      <div testId={`work-run-${first.id}`} onClick={() => { if (!open) markTreeOpen(); setOpen(!open) }} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'pointer' }}>
        {open && <TreeLines shape={RUN_STEM} />}
        <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Chevron open={open} size={12} color={muted(t, 0.7)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          {summary.label && (
            // Counts change in place as calls settle: the old words rise out, the new ones in (no blur: a live row).
            <SwapOnChange active={summary.label} blur={false} style={{ flexShrink: 0, justifyContent: 'flex-start' }}>
              <Label color={tone} size={13} lineHeight={LINE} style={{ hover: { color: t.text } }}>{summary.label}</Label>
            </SwapOnChange>
          )}
          {summary.live && (
            <>
              {summary.label && <Dot />}
              <div testId="work-run-live" style={{ display: 'flex', flexShrink: 1, minWidth: 0 }}>
                <Shimmer text={summary.live} color={tone} size={13} lineHeight={LINE} />
              </div>
            </>
          )}
          {summary.failed && (
            <>
              {(summary.label || summary.live) && <Dot />}
              <Label color={destructive(t, 0.8)} size={13} lineHeight={LINE} style={{ flexShrink: 0 }}>{summary.failed}</Label>
            </>
          )}
        </div>
      </div>
      <Collapse open={open} testId={`work-run-panel-${first.id}`}>
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 2, marginLeft: MEMBER_INSET }}>
          <TreeGroup x={8 - MEMBER_INSET} tickEnd={-TICK_GAP} inset={2} open={open} arrive>
            {blocks.map((block, i) => (
              <RunMember key={block.id} block={block} ctx={ctx} index={i} count={blocks.length} live={block.id === liveThinkingId} />
            ))}
          </TreeGroup>
        </div>
      </Collapse>
      {tree.lines}
    </div>
  )
})

function Dot() {
  const t = useTheme()
  return <Label color={muted(t, 0.7)} size={13} lineHeight={LINE} style={{ flexShrink: 0, paddingLeft: 5, paddingRight: 5 }}>·</Label>
}

/** A member's place on the run's stem; history (an old row remounted) never animates in. */
function RunMember({ block, ctx, index, count, live }: { block: Block; ctx: RowContext; index: number; count: number; live: boolean }) {
  const fresh = useFresh(block.at)
  const anchor = block.kind === 'runtime_task' ? 16 : MEMBER_ANCHOR
  return (
    <TreeItem joint="node" last={index === count - 1} index={index} count={count} anchor={anchor} tickEnd={block.kind === 'runtime_task' ? 1 - TICK_GAP : undefined} fresh={fresh}>
      {block.kind === 'tool' ? <ToolChipRow block={block} ctx={ctx} /> : block.kind === 'assistant' ? <ThoughtRow block={block} live={live} /> : <WorkRow block={block} ctx={ctx} />}
    </TreeItem>
  )
}

/** The verb of a member: past or present tense, or what failed ("Failed to read"). */
function memberVerb(view: ReturnType<typeof toolView>, target: ToolTarget | null, isError: boolean): string {
  if (!target) return view.label
  if (!isError) return view.activity.verb
  const failed: Partial<Record<string, string>> = { read: 'Failed to read', edit: 'Failed to edit', write: 'Failed to write', command: 'Failed to run', search: 'Failed to search for' }
  return failed[view.activity.kind] ?? view.label
}

/** A tool call in a run: verb, chip, line counts; its output (and nested calls) open below. */
const ToolChipRow = memo(function ToolChipRow({ block, ctx }: { block: ToolBlock; ctx: RowContext }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`tool:${block.id}`, false)
  const task = ctx.tasksByToolCall.get(block.call.id)
  const active = !!task && isTaskActive(task)
  const view = useMemo(() => toolView(block, active), [block, active])
  const target = useMemo(() => (view.surface || view.item ? null : toolTarget(block.call, view.activity)), [block.call, view])
  const counts = useMemo(() => (view.activity.kind === 'edit' || view.activity.kind === 'write' ? toolLineCounts(block.call) : null), [block.call, view.activity.kind])
  const children = ctx.childrenByParent.get(block.call.id) ?? []
  const canExpand = children.length > 0 || view.hasOutput
  const tree = useTreeSlot()
  const running = !block.complete || active
  const tone = block.isError ? destructive(t, 0.85) : muted(t)
  const toggle = canExpand ? () => { if (!open) markTreeOpen(); setOpen(!open) } : undefined
  const verb = memberVerb(view, target, block.isError)
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: 1, paddingBottom: 1, minWidth: 0 }}>
      <div testId={`tool-row-${block.call.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6, height: MEMBER_LINE, minWidth: 0 }}>
        <div onClick={toggle} style={{ display: 'flex', flexShrink: target ? 0 : 1, minWidth: 0, cursor: toggle ? 'pointer' : 'default' }}>
          {running ? <Shimmer text={verb} color={tone} size={13} lineHeight={MEMBER_LINE} /> : <Label color={tone} size={13} lineHeight={MEMBER_LINE} truncate style={{ hover: { color: block.isError ? tone : t.text } }}>{verb}</Label>}
        </div>
        {target?.kind === 'files' && <FileChips paths={target.paths} threadId={ctx.threadId} failed={block.isError} />}
        {target?.kind === 'command' && <Chip text={`$ ${target.command}`} mono failed={block.isError} onClick={toggle} testId={`command-chip-${block.call.id}`} />}
        {target?.kind === 'query' && (
          <>
            <Chip text={target.query} failed={block.isError} onClick={toggle} testId={`query-chip-${block.call.id}`} />
            {target.scope && <Label color={muted(t, 0.75)} size={12} lineHeight={MEMBER_LINE} truncate style={{ flexShrink: 1 }}>{target.scope === 'the web' ? 'on the web' : `in ${basename(target.scope)}`}</Label>}
          </>
        )}
        {counts && (counts.additions > 0 || counts.deletions > 0) && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {counts.additions > 0 && <Label color={t.v('--color-decoration-added')} size={12} lineHeight={MEMBER_LINE}>{`+${counts.additions}`}</Label>}
            {counts.deletions > 0 && <Label color={t.v('--color-decoration-deleted')} size={12} lineHeight={MEMBER_LINE}>{`−${counts.deletions}`}</Label>}
          </div>
        )}
        {view.surface?.app && !view.label.endsWith(view.surface.app) && <Label color={muted(t, 0.55)} size={11}>{view.surface.app}</Label>}
        <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', flexGrow: 1, minWidth: 8, cursor: toggle ? 'pointer' : 'default' }}>
          {canExpand && <Chevron open={open} size={12} color={muted(t, 0.55)} />}
        </div>
      </div>
      {canExpand && <ToolPanel block={block} ctx={ctx} view={view} open={open} nested={children} />}
      {tree.lines}
    </div>
  )
})

/** Up to two file chips, then "+N". */
function FileChips({ paths, threadId, failed }: { paths: string[]; threadId: ThreadId; failed: boolean }) {
  const t = useTheme()
  const shown = paths.slice(0, 2)
  return (
    <>
      {shown.map((path) => <FileChip key={path} path={path} threadId={threadId} failed={failed} />)}
      {paths.length > shown.length && <Label color={muted(t, 0.75)} size={12} lineHeight={MEMBER_LINE} style={{ flexShrink: 0 }}>{`+${paths.length - shown.length}`}</Label>}
    </>
  )
}

/** zeron's file badge: a 22 px ink well holding a 20 px icon well (14 px file-type icon) and the file's name. Opens the
 *  file as a tab beside the chat (`openTabFromPane`, like a chat file link), relative to the thread's workspace. */
function FileChip({ path, threadId, failed }: { path: string; threadId: ThreadId; failed: boolean }) {
  const t = useTheme()
  const g = useGlass()
  const pane = usePaneAccess()
  const kind = getFileIconName(path)
  const color = fileIconColors[kind] ?? (kind === 'vercel' ? t.text : fileIconColors['code-brackets']!)
  const well = t.variant === 'dark' ? `rgba(0, 0, 0, ${g.on ? 0.32 : 0.16})` : `rgba(255, 255, 255, ${g.on ? 0.32 : 0.16})`
  const [image, setImage] = useState(false)
  const open = async () => {
    // An image opens in the viewer, wherever it is: the daemon serves it from the workspace, from the folder its harness keeps
    // this session's pasted images in, or when a message names it (`ThreadImagePreview`).
    if (isImageFile(path)) { setImage(true); return }
    try {
      const cwd = pane.get().open.thread?.cwd
      const relative = underWorkspace(path, cwd) ?? await resolveWorkspaceFile(getClient(), threadId, path) ?? (path.startsWith('/') ? null : path)
      if (!relative) throw new Error(`${basename(path)} is outside this thread's workspace. Ask the agent to copy it into the workspace.`)
      openTabFromPane(pane.id, { kind: 'file', path: relative, root: 'thread' })
    } catch (e) { reportError('Unable to open the file', e) }
  }
  return (
    <>
    <div testId={`file-chip-${path}`} onClick={() => void open()} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, paddingLeft: 1, paddingRight: 6, borderRadius: 5, backgroundColor: ink(t, 0.06), flexShrink: 1, minWidth: 0, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.1) } }}>
      <div style={{ display: 'flex', width: 20, height: 20, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: well, flexShrink: 0 }}>
        <Icon source={menuFileIcons[kind] ?? menuFileIcons['code-brackets']!} size={14} color={color} />
      </div>
      <Label color={failed ? destructive(t, 0.85) : fg(t, 0.85)} size={12} lineHeight={18} truncate>{basename(path)}</Label>
    </div>
    {image && <ThreadImagePreview threadId={threadId} source={path} onClose={() => setImage(false)} />}
    </>
  )
}

/** A command (`$ bun test`, monospace) or a query in the same ink well as a file chip. */
function Chip({ text, mono = false, failed, onClick, testId }: { text: string; mono?: boolean; failed: boolean; onClick?: () => void; testId: string }) {
  const t = useTheme()
  return (
    <div testId={testId} onClick={onClick} style={{ display: 'flex', alignItems: 'center', height: 22, paddingLeft: 6, paddingRight: 6, borderRadius: 5, backgroundColor: ink(t, 0.06), flexShrink: 1, minWidth: 0, cursor: onClick ? 'pointer' : 'default', ...(onClick ? { hover: { backgroundColor: ink(t, 0.1) } } : {}) }}>
      <Label color={failed ? destructive(t, 0.85) : fg(t, 0.85)} size={12} lineHeight={18} font={mono ? FONT_MONO : undefined} truncate>{text}</Label>
    </div>
  )
}

/** Reasoning inside a run: "Thought" (or "Thinking" while it streams); the text opens below. */
const ThoughtRow = memo(function ThoughtRow({ block, live }: { block: Extract<Block, { kind: 'assistant' }>; live: boolean }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`thinking:${block.id}`, false)
  const tree = useTreeSlot()
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: 1, paddingBottom: 1, minWidth: 0 }}>
      <div testId={`thought-${block.id}`} onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: MEMBER_LINE, cursor: 'pointer' }}>
        {live ? <Shimmer text="Thinking" color={muted(t)} size={13} lineHeight={MEMBER_LINE} /> : <Label color={muted(t)} size={13} lineHeight={MEMBER_LINE} style={{ hover: { color: t.text } }}>Thought</Label>}
        <Chevron open={open} size={12} color={muted(t, 0.55)} />
      </div>
      <Collapse open={open}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 4, paddingBottom: 4 }}>
          <text style={{ color: muted(t), fontSize: 13, lineHeight: TEXT.lineHeight - 1.5, fontFamily: FONT_UI, userSelect: 'text' }}>{block.thinking}</text>
        </div>
      </Collapse>
      {tree.lines}
    </div>
  )
})
