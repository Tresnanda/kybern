// One project row (SPEC §4): checkbox · name and path · per-harness badges · count line and age. Surface and a 1 px ring; checked is
// an accent ring and the tile shadow. Rows are a fixed 60 px (the list is a virtual list with known heights). Everything that moves
// is paint-only: the drop-in on arrival, the slide that makes room (FLIP), the count line rewriting after a mode change, the
// import bar and the pop. The scene's stores own all state, so a row that scrolls out and back keeps its checkmark and its progress.
import { memo, useRef, useState } from 'react'
import { Skeleton } from '../kit/Skeleton.tsx'
import { DISTANCE, DURATION, EASE } from '../motion/tokens.ts'
import { Tip } from '../nav/overlay.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { ProjectsCheck } from './ProjectsCheck.tsx'
import { bez, riseTransform, stateTransform } from './motion.tsx'
import { ageLine, countLine, displayPath, importLine, ROW_H, staggerDelay, type Row } from './projects.ts'
import { toggleRow, useProjects, type Arrival, type Flip } from './projectsStore.ts'

/** The right column: wide enough for `49 imported · 1 skipped`. */
export const RIGHT_W = 136
const BADGE_MAX = 4
const LINEAR = [0, 0, 1, 1] as const

/** A badge's width: padding 7 + mark 12 + gap 4 + digits (11.5 px, about 6.3 each, rounded up) + padding 7. */
export const badgeWidth = (sessions: number) => 30 + Math.ceil(String(sessions).length * 6.4)
export function badgesFor(row: Row, rowWidth: number) {
  if (rowWidth < 540) return { shown: [] as Row['providers'], width: 0 }
  const shown = [...row.providers].filter((p) => p.sessions > 0).sort((a, b) => b.sessions - a.sessions).slice(0, BADGE_MAX)
  return { shown, width: shown.reduce((n, p) => n + badgeWidth(p.sessions), 0) + Math.max(0, shown.length - 1) * 4 }
}

const tileShadow = (variant: 'light' | 'dark') => ({ offsetX: 0, offsetY: 5, blurRadius: 14, spreadRadius: -6, color: variant === 'dark' ? 'rgba(0, 0, 0, 0.55)' : 'rgba(13, 13, 13, 0.26)' })

export const ProjectRow = memo(function ProjectRow({ row, rank, rowWidth, arrival, flip }: { row: Row; rank: number; rowWidth: number; arrival?: Arrival; flip?: Flip }) {
  const t = useTheme()
  const root = row.root
  const checked = useProjects((s) => s.selected.has(root))
  const mode = useProjects((s) => s.mode)
  const locked = useProjects((s) => s.job !== null)
  const imp = useProjects((s) => s.imports[root])
  // Without chats there is nothing to count along the bottom edge: Add 8 projects and added folders show no bar.
  const noBar = useProjects((s) => s.importMode === 'none') || !!row.added
  const [pressed, setPressed] = useState(false)

  // What the row played on arrival is fixed at mount: a row that scrolls back into view does not drop in again.
  const mount = useRef<{ arrival?: Arrival } | null>(null)
  if (mount.current === null) mount.current = { arrival: arrival && arrival.until > Date.now() ? arrival : undefined }
  const entered = mount.current.arrival
  const motion = PATCHED_NATIVE && !REDUCED_MOTION
  const drop = entered ? riseTransform({ delay: entered.order * entered.step, duration: entered.step < 0.05 ? 0.4 : 0.6, y: entered.step < 0.05 ? -10 : -18, scale: entered.step < 0.05 ? undefined : 0.98, ease: [0.34, 1.1, 0.64, 1] }) : undefined
  const sliding = motion && flip && flip.until > Date.now() ? flip : undefined
  // A new `generation` restarts the slide from its offset: the FLIP of a row that stayed while another dropped in above it.
  const slide = sliding ? { initial: { translateX: 0, translateY: sliding.dy }, animate: { translateX: 0, translateY: 0 }, transition: { duration: 0.55, ease: bez(EASE.out) }, generation: sliding.at } : undefined

  const line = imp ? importLine(imp) : null
  const primary = line ? line.text : countLine(row, mode)
  const primaryKey = line ? `import:${line.kind}` : `count:${primary}`
  const done = line?.kind === 'done'
  const dimmed = locked && !checked
  const path = displayPath(row.root)
  const badges = badgesFor(row, rowWidth)
  // Padding 14 + 16, the 1 px ring, the gaps between children (14 each), the check, the badges and the right column are fixed; the text takes the rest.
  const textWidth = Math.max(120, rowWidth - (badges.width > 0 ? 104 + badges.width : 90) - RIGHT_W)
  const ring = checked ? t.accentBlue : t.cardEdge
  const toggle = () => { if (!locked) toggleRow(root) }

  return (
    <div
      paintTranslate={slide}
      style={{ width: '100%', height: ROW_H }}
    >
      <div paintTransform={drop} style={{ width: '100%', height: ROW_H }}>
        <div
          testId={`project-row:${root}`}
          role="checkbox"
          aria-checked={checked}
          aria-label={row.name}
          tabIndex={locked ? -1 : 0}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'space' || e.key === 'enter') toggle() }}
          onMouseLeave={() => setPressed(false)}
          onMouseDown={() => { if (!locked) setPressed(true) }}
          onMouseUp={() => setPressed(false)}
          paintTransform={stateTransform({ opacity: dimmed ? 0.45 : 1 }, { duration: 0.25 })}
          style={{
            position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, width: '100%', height: ROW_H, paddingLeft: 14, paddingRight: 16, borderRadius: 16,
            backgroundColor: t.surface, borderWidth: 1, borderColor: ring, cursor: locked ? 'default' : 'pointer',
            ...(checked ? { boxShadow: tileShadow(t.variant) } : {}),
            ...(locked ? {} : { hover: { borderColor: checked ? t.accentBlue : ink(t, 0.22) }, focusVisible: { outlineWidth: 2, outlineColor: t.accentBlue, outlineOffset: 1 } }),
            ...(PATCHED_NATIVE ? {} : { opacity: dimmed ? 0.45 : 1 }),
          }}
        >
          <div paintTransform={stateTransform({ scale: pressed && motion ? 0.88 : 1 }, { duration: 0.12 })} style={{ display: 'flex', flexShrink: 0 }}>
            <ProjectsCheck checked={checked} done={done} animateFirst={!!entered} delay={entered ? entered.order * entered.step + 0.35 : 0} />
          </div>
          <Tip label={path} side="bottom">
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: textWidth, minWidth: 0 }}>
              <Label color={checked ? t.text : t.textSecondary} size={14} lineHeight={20} weight={600} truncate style={{ pointerEvents: 'none' }}>{row.name}</Label>
              <Label color={t.textTertiary} size={12} lineHeight={16} truncate style={{ marginTop: 2, pointerEvents: 'none' }}>{path}</Label>
            </div>
          </Tip>
          <div style={{ flexGrow: 1 }} />
          {badges.shown.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', gap: 4, width: badges.width, flexShrink: 0, pointerEvents: 'none' }}>
              {badges.shown.map((p) => (
                <div key={p.provider} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingLeft: 7, paddingRight: 7, borderRadius: 11, backgroundColor: ink(t, 0.06), flexShrink: 0 }}>
                  <ProviderMark kind={p.provider} size={12} />
                  <Label color={t.textSecondary} size={11.5} lineHeight={16} weight={500} style={{ whiteSpace: 'nowrap' }}>{String(p.sessions)}</Label>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: RIGHT_W, flexShrink: 0, pointerEvents: 'none' }}>
            {/* After a mode change the count line rewrites top to bottom, 28 ms a row. */}
            <CountLine active={primaryKey} text={primary} color={line?.kind === 'waiting' ? t.textTertiary : line?.kind === 'failed' ? t.red : t.textSecondary} delay={line ? 0 : staggerDelay(rank)} />
            <Label color={t.textTertiary} size={12} lineHeight={16} style={{ marginTop: 2, whiteSpace: 'nowrap' }}>{ageLine(row, Date.now())}</Label>
          </div>
          {imp && imp.state !== 'queued' && !noBar && <ImportBar fraction={line?.fraction ?? 0} state={imp.state} green={done} />}
        </div>
      </div>
    </div>
  )
})

/**
 * The count line's text swap (the kit `Swap`'s text motion, no blur), staggered by `delay` in paint. A mode change is one commit for
 * every row: the rows used to wait out their stagger in timers and drop the leaving copy on completion, two commits a row (~45 for a
 * mode change, each a ~9 ms draw). The leaving copy stays mounted, transparent, until the next change.
 */
function CountLine({ active, text, color, delay }: { active: string; text: string; color: string; delay: number }) {
  const state = useRef<{ active: string; text: string; color: string; gen: number; prev: { text: string; color: string } | null }>({ active, text, color, gen: 0, prev: null })
  const s = state.current
  if (s.active !== active) state.current = { active, text, color, gen: s.gen + 1, prev: { text: s.text, color: s.color } }
  else { s.text = text; s.color = color }
  const { gen, prev } = state.current
  const motion = PATCHED_NATIVE && gen > 0
  const enter = !motion ? undefined : REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, ease: bez(EASE.out) } }
    : { initial: { opacity: 0, translateY: DISTANCE.micro }, animate: { opacity: 1, translateY: 0 }, transition: { duration: DURATION.fast, delay, ease: bez(EASE.smoothOut) } }
  const leave = REDUCED_MOTION
    ? { initial: false as const, animate: { opacity: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 1, translateY: 0 }, animate: { opacity: 0, translateY: -DISTANCE.micro }, transition: { duration: DURATION.quick, delay, ease: bez(EASE.inOut) } }
  const label = (value: string, tint: string) => <Label color={tint} size={12} lineHeight={16} style={{ whiteSpace: 'nowrap' }}>{value}</Label>
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', width: '100%' }}>
      <div key={gen} paintTransform={enter} style={{ display: 'flex', justifyContent: 'flex-end' }}>{label(state.current.text, state.current.color)}</div>
      {prev && PATCHED_NATIVE && (
        <div key={`out-${gen}`} paintTransform={leave} style={{ position: 'absolute', right: 0, top: 0, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' }}>{label(prev.text, prev.color)}</div>
      )}
    </div>
  )
}

/** The 2 px progress bar along the row's bottom: grows with the project's own progress, turns green, then fades. */
function ImportBar({ fraction, state, green }: { fraction: number; state: string; green: boolean }) {
  const t = useTheme()
  if (!PATCHED_NATIVE) return null
  return (
    <div
      paintTransform={{ initial: { opacity: 0 }, animate: { opacity: state === 'running' ? 1 : 0 }, transition: { duration: 0.25, delay: state === 'running' ? 0 : 0.5, ease: bez(EASE.out) }, retain: true }}
      style={{ position: 'absolute', left: 14, right: 14, bottom: 5, height: 2, borderRadius: 1, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <div
        paintTransform={{ initial: false, animate: { scaleX: Math.min(1, Math.max(0, fraction)) }, transition: { duration: 0.25, ease: bez(LINEAR) }, origin: [0, 0.5], retain: true }}
        style={{ width: '100%', height: 2, backgroundColor: green ? t.green : t.accentBlue, pointerEvents: 'none' }}
      />
    </div>
  )
}

/** Three of these hold the list's place until the first rows land (SPEC §4). */
export function SkeletonRow({ index }: { index: number }) {
  const t = useTheme()
  return (
    <div
      paintTransform={riseTransform({ delay: index * 0.08, y: 8 })}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, width: '100%', height: ROW_H, paddingLeft: 14, paddingRight: 16, borderRadius: 16, backgroundColor: t.surface, borderWidth: 1, borderColor: t.cardEdge }}
    >
      <Skeleton width={16} height={16} radius={5} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexGrow: 1 }}>
        <Skeleton width={110 + (index % 2) * 34} height={12} radius={6} />
        <Skeleton width={190 - (index % 2) * 30} height={10} radius={5} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        <Skeleton width={78} height={12} radius={6} />
        <Skeleton width={48} height={10} radius={5} />
      </div>
    </div>
  )
}
