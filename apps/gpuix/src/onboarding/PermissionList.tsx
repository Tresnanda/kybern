// Preferences, right column (SPEC §5): the default permission mode. Four rows, one highlight (radius 14, surface and shadow) that
// slides between them by `paintTranslate`; Full access tints it with the full-access orange and opens a warning under the list.
// The picked icon wiggles once (Full access shakes instead). Rows are radios with a roving tab stop and arrow keys. Picking writes
// `default_permission_mode` through the settings store, which ignores a write while another is in flight, so the newest pick is
// retried until the daemon has it.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '../../../../packages/kybern-client/src/types.ts'
import { MODES } from '../composer/PermissionPicker.tsx'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { Icon } from '../icons.tsx'
import { useControls } from '../kit/controls.ts'
import { withAlpha } from '../kit/Switch.tsx'
import { Collapse } from '../motion/kit.tsx'
import { Presence, type Exit } from '../motion/Presence.tsx'
import { pressTransform } from '../motion/press.ts'
import { EASE } from '../motion/tokens.ts'
import { N } from '../nav/glyphs.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { latestSettings, refreshSettings, updateSettings, useSettings } from '../settings/store.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { canvasColor } from './Grid.tsx'
import { bez } from './motion.tsx'
import { arrowTarget, MODE_PAD, modeRowHeight, modeY, warningHeight, warningLines } from './prefsLayout.ts'

/** The words the user reads (SPEC §5); ids and glyphs are the composer's own `MODES`. */
const COPY: Record<PermissionMode, string> = {
  supervised: 'Ask before editing files or running commands',
  'accept-edits': 'Edit files freely, ask before running commands',
  auto: 'Ask only for actions that look unsafe',
  'full-access': 'Any file, any command, the whole internet',
}
export const WARNING = 'Agents can change any file and reach the internet without asking. Use it only for folders you trust.'
/** The product default, which carries the "Default" tag whatever is saved. */
const DEFAULT_MODE: PermissionMode = 'supervised'
const HIGHLIGHT = { type: 'tween', duration: 0.3, ease: bez(EASE.out) } as const
/** The Full access tint fades in and out over 250 ms (Reduce Motion: 150 ms in, `Presence`'s 100 ms out). */
const TINT_IN = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: REDUCED_MOTION ? 0.15 : 0.25, ease: bez(EASE.out) } }
const TINT_OUT: Exit = { to: { opacity: 0 }, duration: 0.25, ease: EASE.out }

// ─── Saving ───────────────────────────────────────────────────────────────

let target: PermissionMode | null = null
let running = false
/** Write the newest pick; the store drops a write made while another is saving, so wait and ask again (at most a few times). */
async function persist(mode: PermissionMode) {
  target = mode
  if (running) return
  running = true
  try {
    for (let attempt = 0; attempt < 6 && target; attempt++) {
      if (!latestSettings()) await refreshSettings()
      const want: PermissionMode = target
      if (latestSettings()?.default_permission_mode === want) break
      await updateSettings({ default_permission_mode: want })
      if (latestSettings()?.default_permission_mode === want) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (target && latestSettings()?.default_permission_mode !== target) toast.error('Couldn’t save the permission mode.', { id: 'onboarding-permission-mode', description: 'Choose it in Settings › General.' })
  } finally { running = false; target = null }
}

// ─── The icon that answers a pick ─────────────────────────────────────────

/** Wiggle: scale 1.16 and −10° → 6° → 0 over 520 ms. Full access shakes ±3 px over 380 ms instead. */
function answer(full: boolean, bump: number) {
  if (!PATCHED_NATIVE || REDUCED_MOTION || bump === 0) return undefined
  return full
    ? { initial: { translateX: 0 }, keyframes: [{ offset: 0.15, translateX: -3 }, { offset: 0.35, translateX: 3 }, { offset: 0.55, translateX: -3 }, { offset: 0.75, translateX: 2 }], animate: { translateX: 0 }, transition: { duration: 0.38, ease: bez(EASE.out) } }
    : { initial: { scale: 1, rotate: 0 }, keyframes: [{ offset: 0.25, scale: 1.16, rotate: -10 }, { offset: 0.6, scale: 1.16, rotate: 6 }], animate: { scale: 1, rotate: 0 }, transition: { duration: 0.52, ease: bez(EASE.out) } }
}

const ModeIcon = memo(function ModeIcon({ source, selected, full, bump, canvas }: { source: string; selected: boolean; full: boolean; bump: number; canvas: string }) {
  const t = useTheme()
  const chip = selected ? (full ? t.fullAccess : t.text) : t.buttonSecondary
  const glyph = selected ? (full ? '#ffffff' : canvas) : t.textSecondary
  return (
    <div
      paintTransform={PATCHED_NATIVE ? { initial: false, animate: { scale: selected && !REDUCED_MOTION ? 1.06 : 1 }, transition: { duration: 0.3, ease: bez(EASE.out) }, retain: true } : undefined}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flexShrink: 0, borderRadius: 9, backgroundColor: chip, pointerEvents: 'none' }}
    >
      <div key={bump} paintTransform={answer(full, bump)} style={{ display: 'flex', pointerEvents: 'none' }}>
        <Icon source={source} size={17} color={glyph} style={{ pointerEvents: 'none' }} />
      </div>
    </div>
  )
})

// ─── The list ─────────────────────────────────────────────────────────────

export const PermissionList = memo(function PermissionList({ column }: { column: number }) {
  const t = useTheme()
  const c = useControls()
  const renderer = useGpuixRequired()
  const saved = useSettings().settings?.default_permission_mode
  const [choice, setChoice] = useState<PermissionMode | null>(null)
  const [bumps, setBumps] = useState<Partial<Record<PermissionMode, number>>>({})
  const nodes = useRef(new Map<PermissionMode, PublicInstance>())
  // The list reflects the saved value; settings are only read by the Settings page, so ask once here.
  useEffect(() => { void refreshSettings() }, [])
  useEffect(() => { if (choice !== null && saved === choice) setChoice(null) }, [saved, choice])

  const shown: PermissionMode = choice ?? saved ?? DEFAULT_MODE
  const index = Math.max(0, MODES.findIndex((m) => m.mode === shown))
  const full = shown === 'full-access'
  const rowH = modeRowHeight(column)
  const canvas = canvasColor(t)
  const pick = (mode: PermissionMode) => {
    setBumps((old) => ({ ...old, [mode]: (old[mode] ?? 0) + 1 }))
    if (mode === shown) return
    setChoice(mode)
    void persist(mode)
  }
  const onKey = (mode: PermissionMode, key: string) => {
    const to = arrowTarget(key, MODES.findIndex((m) => m.mode === mode), MODES.length, 'both')
    if (to === null) return
    const next = MODES[to]!.mode
    pick(next)
    const node = nodes.current.get(next)
    if (node) renderer.focusElement?.(node.id)
  }

  const edge = t.cardEdge
  const lines = warningLines(column, WARNING.length)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: column }}>
      <div role="radiogroup" aria-label="When an agent wants to change something" style={{ position: 'relative', display: 'flex', flexDirection: 'column', padding: MODE_PAD, width: column }}>
        {/* The one highlight: it rides a retained translation, so a pick moves no layout. */}
        <PaintTranslate
          animate={{ translateX: 0, translateY: modeY(index, rowH) }}
          transition={REDUCED_MOTION || !PATCHED_NATIVE ? { duration: 0 } : HIGHLIGHT}
          style={{ position: 'absolute', left: MODE_PAD, top: MODE_PAD, width: column - MODE_PAD * 2, height: rowH, pointerEvents: 'none' }}
        >
          <div
            style={{
              position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 14, backgroundColor: t.surface, borderWidth: 1, borderColor: edge,
              boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 14, spreadRadius: -6, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(13, 13, 13, 0.22)' },
              pointerEvents: 'none',
            }}
          />
          {/* The orange exists only while Full access is picked. Held at a retained opacity of 0 instead, a full draw presented before
              that opacity was applied again painted it at full strength: the list flashed orange when anything on the scene changed. */}
          <Presence show={full} enter={TINT_IN} exit={TINT_OUT} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
            <div
              testId="prefs-mode-tint"
              style={{ flexGrow: 1, borderRadius: 14, backgroundColor: withAlpha(t.fullAccess, t.variant === 'dark' ? 0.16 : 0.1), borderWidth: 1, borderColor: withAlpha(t.fullAccess, 0.35), pointerEvents: 'none' }}
            />
          </Presence>
        </PaintTranslate>
        {MODES.map((m, i) => {
          const selected = i === index
          const isFull = m.mode === 'full-access'
          return (
            <div
              key={m.mode}
              ref={(node) => { if (node) nodes.current.set(m.mode, node); else nodes.current.delete(m.mode) }}
              testId={`prefs-mode-${m.mode}`}
              role="radio"
              aria-checked={selected}
              aria-label={`${m.label}. ${COPY[m.mode]}${m.mode === DEFAULT_MODE ? '. Default' : ''}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(m.mode)}
              onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { e.preventDefault(); pick(m.mode) } else onKey(m.mode, e.key ?? '') }}
              paintTransform={pressTransform(true, 0.99)}
              style={{
                position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, height: rowH, paddingLeft: 14, paddingRight: 14, borderRadius: 14, cursor: 'pointer',
                hover: { backgroundColor: selected ? 'rgba(0, 0, 0, 0)' : t.hover }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: -2 },
              }}
            >
              <ModeIcon source={m.icon} selected={selected} full={isFull} bump={bumps[m.mode] ?? 0} canvas={canvas} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
                  <Label color={isFull && selected ? t.fullAccess : selected ? t.text : t.textSecondary} size={14} lineHeight={20} weight={600}>{m.label}</Label>
                  {m.mode === DEFAULT_MODE && <Label color={t.textTertiary} size={11} lineHeight={16} weight={600}>Default</Label>}
                </div>
                <Label color={t.textSecondary} size={13} lineHeight={18} style={{ width: '100%' }}>{COPY[m.mode]}</Label>
              </div>
            </div>
          )
        })}
      </div>
      <Collapse open={full} height={warningHeight(lines)}>
        <div role="alert" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8, width: column, paddingTop: 10, paddingLeft: 4 }}>
          <div style={{ display: 'flex', paddingTop: 2 }}><Icon source={N.alert} size={15} color={t.fullAccess} /></div>
          <Label color={t.fullAccess} size={12.5} lineHeight={18} weight={500} style={{ width: column - 8 - 23 }}>{WARNING}</Label>
        </div>
      </Collapse>
    </div>
  )
})

