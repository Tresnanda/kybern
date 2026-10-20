import { useLoopRunning, useLoopVisibility } from '../native/loop-visibility.ts'
import { ISLAND, NATIVE_PAINT_ANIMATIONS, useLoaderStep } from '../MatrixLoader.tsx'
import { motion } from '@gpuix/react'
import type { TaskPriority, TaskStatus } from '../../../../packages/kybern-client/src/types.ts'
import { EASE_OUT, ink, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { useNav } from '../nav/store.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'

// Paths mirror desktop TaskGlyphs.tsx; SVG is the native renderer's single node.
const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14">${body}</svg>`
/** The status glyph as SVG source and its color, for native text (editor task references). */
export function statusGlyphSource(status: TaskStatus, t: ReturnType<typeof useTheme>): { svg: string; color: string } {
  const color = status === 'running' ? t.taskRun : status === 'needs_review' ? t.taskReview : status === 'done' ? t.taskDone : status === 'canceled' ? ink(t, t.variant === 'dark' ? 0.22 : 0.2) : t.textTertiary
  const ring = `<circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" ${status === 'inbox' ? 'stroke-dasharray="1.45 1.56"' : ''}/>`
  const body = status === 'done'
    ? '<defs><mask id="check"><rect width="14" height="14" fill="white"/><path d="M4.4 7.2 6.2 9 9.7 5.2" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><circle cx="7" cy="7" r="6.5" fill="currentColor" mask="url(#check)"/>'
    : status === 'canceled'
      ? '<defs><mask id="cross"><rect width="14" height="14" fill="white"/><path d="M5 5l4 4M9 5 5 9" stroke="black" stroke-width="1.5" stroke-linecap="round"/></mask></defs><circle cx="7" cy="7" r="6.5" fill="currentColor" mask="url(#cross)"/>'
      : `${ring}${status === 'running' ? '<path d="M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z" fill="currentColor"/>' : status === 'needs_review' ? '<path d="M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z" fill="currentColor"/>' : ''}`
  return { svg: wrap(body), color }
}
export function StatusGlyph({ status, mono = false }: { status: TaskStatus; mono?: boolean }) {
  const t = useTheme()
  const color = mono
    ? t.textSecondary
    : status === 'running'
      ? t.taskRun
      : status === 'needs_review'
        ? t.taskReview
        : status === 'done'
          ? t.taskDone
          : status === 'canceled'
            ? ink(t, t.variant === 'dark' ? 0.22 : 0.2)
            : t.textTertiary
  const ring = `<circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" ${status === 'inbox' ? 'stroke-dasharray="1.45 1.56"' : ''}/>`
  const body =
    status === 'done'
      ? mono
        ? `${ring}<path d="M4.6 7.1 6.3 8.8 9.5 5.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
        : ' <defs><mask id="check"><rect width="14" height="14" fill="white"/><path d="M4.4 7.2 6.2 9 9.7 5.2" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><circle cx="7" cy="7" r="6.5" fill="currentColor" mask="url(#check)"/>'
      : status === 'canceled'
        ? '<defs><mask id="cross"><rect width="14" height="14" fill="white"/><path d="M5 5l4 4M9 5 5 9" stroke="black" stroke-width="1.5" stroke-linecap="round"/></mask></defs><circle cx="7" cy="7" r="6.5" fill="currentColor" mask="url(#cross)"/>'
        : `${ring}${status === 'running' ? '<path d="M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z" fill="currentColor"/>' : status === 'needs_review' ? '<path d="M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z" fill="currentColor"/>' : ''}`
  if (status === 'running' && !mono) return NATIVE_PAINT_ANIMATIONS ? <RunningGlyph ring={wrap(ring)} color={color} /> : <LegacyRunningGlyph source={wrap(body)} color={color} />
  return <svg source={wrap(body)} style={{ width: 14, height: 14, color, flexShrink: 0, pointerEvents: 'none' }} />
}
export function PriorityGlyph({ priority }: { priority: TaskPriority }) {
  const t = useTheme()
  const body =
    priority === 0
      ? '<g fill="currentColor" opacity=".55"><rect x="1.5" y="6.25" width="2.6" height="1.5" rx=".75"/><rect x="5.7" y="6.25" width="2.6" height="1.5" rx=".75"/><rect x="9.9" y="6.25" width="2.6" height="1.5" rx=".75"/></g>'
      : priority === 1
        ? '<defs><mask id="urgent"><rect width="14" height="14" fill="white"/><path d="M7 3.9v3.6" stroke="black" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="9.9" r=".95" fill="black"/></mask></defs><rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" mask="url(#urgent)"/>'
        : [4, 7, 10]
            .map(
              (h, i) =>
                `<rect x="${1.5 + i * 4.25}" y="${12 - h}" width="2.5" height="${h}" rx=".8" fill="currentColor" opacity="${i < 5 - priority ? 1 : 0.3}"/>`,
            )
            .join('')
  return (
    <svg
      source={wrap(body)}
      style={{ width: 14, height: 14, color: priority === 1 ? t.taskUrgent : t.textTertiary, pointerEvents: 'none' }}
    />
  )
}
export function Check({ checked, onClick, testId }: { checked: boolean; onClick: () => void; testId?: string }) {
  const t = useTheme()
  const keyboard = useNav((s) => s.keyboardNav)
  return (
    <div
      testId={testId}
      tabIndex={0}
      role="checkbox"
      aria-checked={checked}
      aria-label="Select task"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'space') onClick()
      }}
      style={{ width: 26, height: 30, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
    >
      {/* `TaskCheckBox`: a 14px box, 1.5 stroke, filled with the foreground and a surface-coloured tick once picked. */}
      <svg
        source={checked
          ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><defs><mask id="tick"><rect width="14" height="14" fill="white"/><path d="M4.3 7.2 6.1 9 9.7 5.2" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><rect x="1.25" y="1.25" width="11.5" height="11.5" rx="3.25" fill="currentColor" stroke="currentColor" stroke-width="1.5" mask="url(#tick)"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><rect x="1.25" y="1.25" width="11.5" height="11.5" rx="3.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'}
        style={{ width: 14, height: 14, color: checked ? t.text : ink(t, 0.4), pointerEvents: 'none' }}
      />
    </div>
  )
}

function RunningGlyph({ ring, color }: { ring: string; color: string }) {
  return <RunningPaint ring={ring} color={color} opacity={1} />
}
function LegacyRunningGlyph({ source, color }: { source: string; color: string }) {
  const loop = useLoopVisibility(!REDUCED_MOTION)
  const step = useLoaderStep(loop.visible)
  const opacity = REDUCED_MOTION ? 1 : .55 + .45 * (1 - Math.cos(step * Math.PI / 4)) / 2
  return <div ref={loop.ref} {...ISLAND} style={{ width: 14, height: 14, flexShrink: 0, pointerEvents: 'none' }}><svg source={source} style={{ width: 14, height: 14, color, opacity, pointerEvents: 'none' }} /></div>
}
function RunningPaint({ ring, color, opacity }: { ring: string; color: string; opacity: number }) {
  const loop = useLoopRunning(!REDUCED_MOTION)
  return <div ref={loop.ref} {...ISLAND} style={{ width: 14, height: 14, flexShrink: 0, pointerEvents: 'none',position:'relative' }}>
    <svg source={ring} style={{width:14,height:14,color,pointerEvents:'none'}}/>
    <svg {...(NATIVE_PAINT_ANIMATIONS && loop.running ? {paintAnimation:{kind:'breathe',cycleMs:3200}} : {})} source={wrap('<path d="M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z" fill="currentColor"/>')} style={{position:'absolute',left:0,top:0,width:14,height:14,color,opacity,pointerEvents:'none'}}/>
  </div>
}
