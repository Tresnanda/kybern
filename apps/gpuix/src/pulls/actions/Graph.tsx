// A run's jobs on their workflow's `needs` graph (ADE-97, "C · Pipeline"): columns by dependency depth, curved edges, the
// failure path red from its root to the final job, skipped jobs dashed and muted, running jobs amber with a progress line
// (elapsed against the job's usual time, when a passing run of the workflow is known), a waiting final job saying what it
// waits for. When the workflow file can't place every job the jobs stand in one column in run order, with the edges known.
//
// Cost: the graph is one island (`cache`, definite size); its edges are not elements but a handful of SVGs for the whole run,
// one per ink (neutral, amber, red), since an SVG paints in one colour, plus small cropped layers while something moves.
// Nodes are memoized on their job's state, so a refresh that changes nothing re-renders nothing.
//
// Motion (native stroke animation, no render or layout per frame):
// - edges into running jobs flow: dashes move along them at one 10-unit period per 1200 ms, linear, for six periods (a 7.2 s
//   draw from offset 60 to 0), then rest solid. Only while the graph is painted in a visible window and the pane is shown
//   (`useLoopRunning`); a return restarts it.
// - an edge that becomes solid while you watch (its job finished) draws in, 300 ms ease-out.
// - the failure path draws in once, 350 ms, when the run fails while you watch.
// - status glyphs cross-fade (`SwapOnChange`). Reduce Motion: no flow and no draws; the glyph fades stay.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { runWord, type RunBucket } from '../../../../../packages/kybern-client/src/actions.ts'
import { duration, jobProgress, nodeTime, seconds, waitsFor, type GraphLayout, type JobGraph, type PlacedEdge } from '../../../../../packages/kybern-client/src/actionsPipeline.ts'
import type { WorkflowJob } from '../../../../../packages/kybern-client/src/types.ts'
import { RADIUS } from '../../kit/controls.ts'
import { toneColor } from '../../kit/tone.ts'
import { EASE, SwapOnChange } from '../../motion/kit.tsx'
import { PATCHED_NATIVE } from '../../native/local-build.ts'
import { useLoopRunning } from '../../native/loop-visibility.ts'
import { alpha } from '../../transcript/kit.tsx'
import { ink, Label, REDUCED_MOTION, useTheme } from '../../ui.tsx'
import { row } from '../../usage/controls.tsx'
import { RunGlyph } from './glyph.tsx'
import { LiveClock } from './LiveClock.tsx'

export const NODE_HEIGHT = 32
export const ROW_GAP = 8
/** An estimate of a 13 px SF Pro label's width, for column widths. */
export const measureName = (text: string) => text.length * 6.9

const FLOW = { dash: 5, loops: 6, periodMs: 1200 }
const DRAW_DONE_MS = 300
const DRAW_FAIL_MS = 350
const edgeKey = (e: { from: number; to: number }) => `${e.from}>${e.to}`

type Stroke = { d: string; width: number; opacity: number; dashed?: boolean }
/** One SVG for `strokes`, in the graph's coordinates; `box` crops it (x, y, w, h). */
function svg(strokes: Stroke[], box: [number, number, number, number]): string {
  const [x, y, w, h] = box
  const paths = strokes.map(s => `<path d="${s.d}" stroke="#000" stroke-width="${s.width}" stroke-opacity="${s.opacity}" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="3 3"' : ''}/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" fill="none">${paths}</svg>`
}
/** The box around `edges` (control points included), padded for the stroke. */
function bounds(edges: readonly PlacedEdge[]): [number, number, number, number] {
  const n = edges.flatMap(e => e.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number))
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1)
  const x = Math.floor(Math.min(...xs) - 2), y = Math.floor(Math.min(...ys) - 2)
  return [x, y, Math.ceil(Math.max(...xs) + 2) - x, Math.ceil(Math.max(...ys) + 2) - y]
}

function EdgeLayer({ strokes, box, color, testId, animation }: { strokes: Stroke[]; box: [number, number, number, number]; color: string; testId: string; animation?: object }) {
  if (!strokes.length) return null
  return <svg testId={testId} source={svg(strokes, box)} {...(animation ? { paintAnimation: animation } : {})}
    style={{ position: 'absolute', left: box[0], top: box[1], width: box[2], height: box[3], color, pointerEvents: 'none' }} />
}

interface Draw { key: number; edges: PlacedEdge[]; color: 'neutral' | 'danger'; ms: number }

export function PipelineGraph({ graph, layout, selected, onSelect, usual, live, testId = 'actions-graph' }: {
  graph: JobGraph; layout: GraphLayout; selected: number | undefined; onSelect: (jobId: number) => void
  /** Each job's usual time, by name (a recent passing run of the workflow). */
  usual?: ReadonlyMap<string, number>
  /** The run is in progress: changes from here on are watched, and draw in. */
  live: boolean
  testId?: string
}) {
  const t = useTheme()
  const loop = useLoopRunning(PATCHED_NATIVE && !REDUCED_MOTION)
  const neutral = t.text, amber = toneColor(t, 'warning'), red = toneColor(t, 'danger')

  // Edges that changed while the graph was on screen draw in; until they finish they are left out of the static layers.
  const [draws, setDraws] = useState<Draw[]>([])
  const before = useRef<{ kinds: Map<string, string>; failed: boolean; live: boolean } | null>(null)
  useEffect(() => {
    const kinds = new Map(layout.edges.map(e => [edgeKey(e), e.kind]))
    const failed = graph.failureOrigins.length > 0
    const prev = before.current
    before.current = { kinds, failed, live }
    if (!prev || !PATCHED_NATIVE || REDUCED_MOTION) return
    const next: Draw[] = []
    if (failed && !prev.failed && prev.live) next.push({ key: Date.now(), edges: layout.edges.filter(e => e.kind === 'failure'), color: 'danger', ms: DRAW_FAIL_MS })
    else {
      const finished = layout.edges.filter(e => e.kind === 'done' && (prev.kinds.get(edgeKey(e)) === 'running' || prev.kinds.get(edgeKey(e)) === 'waiting'))
      if (finished.length) next.push({ key: Date.now() + 1, edges: finished, color: 'neutral', ms: DRAW_DONE_MS })
    }
    if (!next.length) return
    setDraws(d => [...d, ...next])
    const timer = setTimeout(() => setDraws(d => d.filter(x => !next.includes(x))), Math.max(...next.map(n => n.ms)) + 60)
    return () => clearTimeout(timer)
  }, [layout, graph.failureOrigins.length, live])

  const drawing = useMemo(() => new Set(draws.flatMap(d => d.edges.map(edgeKey))), [draws])
  const layers = useMemo(() => {
    const full: [number, number, number, number] = [0, 0, Math.max(1, Math.ceil(layout.width)), Math.max(1, Math.ceil(layout.height))]
    const quiet: Stroke[] = [], warm: Stroke[] = [], hot: Stroke[] = []
    const flowing: PlacedEdge[] = []
    for (const e of layout.edges) {
      if (drawing.has(edgeKey(e))) continue
      switch (e.kind) {
        case 'done': quiet.push({ d: e.d, width: 1.25, opacity: t.variant === 'dark' ? .3 : .26 }); break
        case 'skipped': quiet.push({ d: e.d, width: 1.25, opacity: .16, dashed: true }); break
        case 'waiting': (e.hot ? warm : quiet).push({ d: e.d, width: 1.25, opacity: e.hot ? .75 : .3, dashed: true }); break
        case 'running': warm.push({ d: e.d, width: 1.5, opacity: .4 }); flowing.push(e); break
        case 'failure': hot.push({ d: e.d, width: 1.5, opacity: .95 }); break
      }
    }
    return { full, quiet, warm, hot, flowing, flowBox: flowing.length ? bounds(flowing) : null }
  }, [layout, drawing, t.variant])
  const flowKey = layers.flowing.map(edgeKey).join(',')
  const flow = layers.flowBox && loop.running
    ? { kind: 'stroke', cycleMs: FLOW.periodMs * FLOW.loops, delayMs: 0, dash: FLOW.dash, ease: [...EASE.linear], from: FLOW.dash * 2 * FLOW.loops, to: 0 }
    : undefined

  return <div ref={loop.ref} testId={testId} cache style={{ position: 'relative', width: Math.ceil(layout.width), height: Math.ceil(layout.height), flexShrink: 0 }}>
    <EdgeLayer testId="actions-graph-edges" strokes={layers.quiet} box={layers.full} color={neutral} />
    <EdgeLayer testId="actions-graph-edges-running" strokes={layers.warm} box={layers.full} color={amber} />
    <EdgeLayer testId="actions-graph-edges-failure" strokes={layers.hot} box={layers.full} color={red} />
    {flow && layers.flowBox && <EdgeLayer key={`flow:${flowKey}`} testId="actions-graph-flow" strokes={layers.flowing.map(e => ({ d: e.d, width: 1.5, opacity: 1 }))} box={layers.flowBox} color={amber} animation={flow} />}
    {draws.map(d => {
      const box = bounds(d.edges)
      const dash = Math.max(...d.edges.map(e => e.length)) + 4
      const animation = { kind: 'stroke', cycleMs: d.ms, delayMs: 0, dash, ease: [...EASE.out] }
      return <EdgeLayer key={d.key} testId="actions-graph-draw" strokes={d.edges.map(e => ({ d: e.d, width: e.kind === 'failure' ? 1.5 : 1.25, opacity: d.color === 'danger' ? .95 : t.variant === 'dark' ? .3 : .26 }))} box={box} color={d.color === 'danger' ? red : neutral} animation={animation} />
    })}
    {graph.nodes.map(n => {
      const p = layout.nodes.get(n.job.id)!
      return <div key={n.job.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.width, height: p.height, display: 'flex' }}>
        <JobNode job={n.job} bucket={n.bucket} width={p.width} selected={n.job.id === selected} waits={waitsFor(graph, n)} note={nodeTime(graph, n)} progress={n.bucket === 'running' ? jobProgress(n.job, usual) : null} onSelect={onSelect} />
      </div>
    })}
  </div>
}

/** One job: its mark, name and time; a failure red, a running job amber with its progress along the bottom edge, a skipped one dashed. */
const JobNode = memo(function JobNode({ job, bucket, width, selected, waits, note, progress, onSelect }: {
  job: WorkflowJob; bucket: RunBucket; width: number; selected: boolean; waits: number; note: string; progress: number | null; onSelect: (id: number) => void
}) {
  const t = useTheme()
  const red = toneColor(t, 'danger'), amber = toneColor(t, 'warning')
  const dark = t.variant === 'dark'
  const tint = bucket === 'failed' ? red : bucket === 'running' ? amber : null
  const muted = bucket === 'skipped' || bucket === 'cancelled' || bucket === 'queued'
  const edge = selected ? (tint ?? ink(t, dark ? .5 : .42)) : tint ? alpha(tint, .55) : muted ? ink(t, .16) : t.cardEdge
  const time = note || (() => {
    const s = seconds(job.started_at, job.completed_at)
    return s === null ? '' : duration(s)
  })()
  const timeColor = tint ?? t.textTertiary
  return <div testId={`actions-node-${job.id}`} role="button" tabIndex={0} aria-current={selected ? 'true' : undefined}
    aria-label={`${job.name}, ${runWord(job)}${waits ? `, ${note.toLowerCase()}` : ''}`}
    onClick={() => onSelect(job.id)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onSelect(job.id) }}
    style={{
      ...row, position: 'relative', overflow: 'hidden', width, height: NODE_HEIGHT, gap: 8, paddingLeft: 10, paddingRight: 11, borderRadius: RADIUS.md,
      borderWidth: selected ? 1.5 : 1, borderColor: edge, borderStyle: muted ? 'dashed' : 'solid',
      backgroundColor: tint ? alpha(tint, dark ? .1 : .08) : muted ? 'transparent' : ink(t, dark ? .035 : .02),
      hover: { backgroundColor: tint ? alpha(tint, dark ? .14 : .11) : ink(t, dark ? .06 : .045) },
    }}>
    <SwapOnChange kind="icon" active={bucket} style={{ width: 14, height: 14, flexShrink: 0 }}><RunGlyph item={job} size={14} /></SwapOnChange>
    <Label color={muted ? t.textSecondary : t.text} size={13} lineHeight={18} weight={bucket === 'failed' || selected ? 600 : 400} truncate style={{ flexGrow: 1 }}>{job.name}</Label>
    {bucket === 'running'
      ? <LiveClock since={job.started_at} color={amber} size={12} />
      : time && <Label color={bucket === 'failed' ? red : timeColor} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{time}</Label>}
    {progress !== null && <div testId={`actions-node-progress-${job.id}`} style={{ position: 'absolute', left: 10, right: 10, bottom: 0, height: 2, borderRadius: 1, backgroundColor: alpha(amber, .18) }}>
      <div style={{ width: `${Math.round(progress * 1000) / 10}%`, height: 2, borderRadius: 1, backgroundColor: amber }} />
    </div>}
  </div>
})
