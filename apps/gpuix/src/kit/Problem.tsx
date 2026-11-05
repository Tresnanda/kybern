// A failure, in plain words, in the three places one shows up. `ProblemState` is the page or pane that couldn't load (built on `Empty`:
// a tone-tinted icon card, a 15/600 headline, one sentence of help, the fix as the primary button and an optional second one);
// `ProblemRow` is a failure inside a section (the `Card` geometry in the tone); `toast.problem()` (`shell/toasts.tsx`) is a command or
// background job that failed. Never a toast for a page that failed to load. Each carries the technical text behind a ghost "Show details"
// disclosure with a copy button, never as the headline. The words come from `describeProblem` (`packages/kybern-client/src/problems.ts`)
// and the buttons from `problems/props.ts`; these components only draw. Colours and the Increase contrast treatment are `theme.problem`.
import { useEffect, useState, type ReactNode } from 'react'
import { writeClipboardText } from '../platform/os.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { N } from '../nav/glyphs.ts'
import { Icon, type IconName } from '../icons.tsx'
import { FONT_MONO, over } from '../theme.ts'
import { alpha } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Button, glyphSource } from './Button.tsx'
import { Card } from './Card.tsx'
import { RADIUS, useControls } from './controls.ts'
import { Empty, EmptyHeader, EmptyMedia } from './Empty.tsx'
import { IconButton } from './IconButton.tsx'

export type ProblemTone = 'info' | 'warning' | 'danger' | 'neutral'

export interface ProblemButton {
  label: string
  onClick: () => void
  testId?: string
  busy?: boolean
}

export interface ProblemProps {
  /** `info` a setup step (install), `warning` something to sign in or allow, `danger` a failure, `neutral` a machine that is away. Default `danger`. */
  tone?: ProblemTone
  /** The glyph: a kit icon name or an SVG source. Default `alert`. */
  icon?: IconName | string
  /** The outcome or the fix, sentence case, no final period. */
  title: string
  /** One sentence on what to do next. */
  body?: string
  primary?: ProblemButton
  secondary?: ProblemButton
  /** The technical text, shown only when the person opens the details. */
  detail?: string
  testId?: string
}

const column = { display: 'flex', flexDirection: 'column', minWidth: 0 } as const

/** The "Show details" button and, once open, the technical text with its copy button. Each part is placed by the form that uses it. */
function useDetails(detail: string | undefined, testId: string): { toggle: ReactNode; box: ReactNode } {
  const t = useTheme()
  const c = useControls()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  if (!detail) return { toggle: null, box: null }
  const copy = () => { void writeClipboardText(detail).then(() => setCopied(true), () => {}) }
  const toggle = (
    <Button testId={`${testId}-details`} size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} trailing={<Chevron open={open} size={11} color={c.ghost.fg} source={N.chevronDown} turn={180} />}>
      {open ? 'Hide details' : 'Show details'}
    </Button>
  )
  const box = open ? (
    <div testId={`${testId}-detail`} style={{ position: 'relative', width: '100%', minWidth: 0, padding: 8, paddingRight: 34, paddingLeft: 10, borderRadius: RADIUS.field, borderWidth: 1, borderColor: t.cardEdge, backgroundColor: t.codeSurface }}>
      <Label color={t.problem.detail} size={12} lineHeight={18} font={FONT_MONO} style={{ userSelect: 'text' }}>{detail}</Label>
      <div style={{ position: 'absolute', top: 4, right: 4 }}>
        <IconButton testId={`${testId}-copy`} size="sm" icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy details'} onClick={copy} />
      </div>
    </div>
  ) : null
  return { toggle, box }
}

/** A tone's glyph colour and its tint at a step, for fills and for edges: the neutral tone tints from opaque ink, weighted, so its edge can rise under Increase contrast. */
function toneOf(t: ReturnType<typeof useTheme>, name: ProblemTone) {
  const p = t.problem
  const neutral = name === 'neutral'
  const base = neutral ? p.neutralInk : p[name]
  return { glyph: p[name], fill: (step: number) => alpha(base, neutral ? step * p.neutralFill : step), edge: (step: number) => alpha(base, neutral ? step * p.neutralEdge : step) }
}

/** The tint of the icon card: the tone laid over the card base so the card stays opaque, and the two cards fanned behind it. */
function tint(t: ReturnType<typeof useTheme>, name: ProblemTone) {
  const p = t.problem
  const c = toneOf(t, name)
  return { fill: over(c.fill(p.iconFill), p.cardBase), edge: c.edge(p.iconEdge), backFill: over(c.fill(p.backFill), p.cardBase), backEdge: c.edge(p.backEdge), icon: c.glyph }
}

/** A page or pane that couldn't load or run. Fills its parent and centres: give it a parent with a size. */
export function ProblemState({ tone: name = 'danger', icon = 'alert', title, body, primary, secondary, detail, testId = 'problem' }: ProblemProps) {
  const t = useTheme()
  const details = useDetails(detail, testId)
  return (
    <div role="alert" testId={testId} style={{ ...column, flexGrow: 1, width: '100%' }}>
      <Empty style={{ gap: 16, padding: 24 }}>
        <EmptyHeader>
          <EmptyMedia variant="icon" icon={glyphSource(icon)} tint={tint(t, name)} />
          <Label color={t.text} size={15} lineHeight={22} weight={600} style={{ textAlign: 'center', maxWidth: 320 }}>{title}</Label>
          {body && <Label color={t.problem.help} size={13} lineHeight={20} style={{ textAlign: 'center', maxWidth: 300, marginTop: 4 }}>{body}</Label>}
        </EmptyHeader>
        {(primary || secondary || details.toggle) && (
          <div style={{ ...column, alignItems: 'center', gap: 8, width: '100%', maxWidth: 320 }}>
            {(primary || secondary) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
                {primary && <Button testId={primary.testId ?? `${testId}-primary`} variant="primary" busy={primary.busy} onClick={primary.onClick}>{primary.label}</Button>}
                {secondary && <Button testId={secondary.testId ?? `${testId}-secondary`} variant={primary ? 'secondary' : 'primary'} busy={secondary.busy} onClick={secondary.onClick}>{secondary.label}</Button>}
              </div>
            )}
            {details.toggle}
            {details.box}
          </div>
        )}
      </Empty>
    </div>
  )
}

/** A failure inside a section: the `Card` in the tone, a leading glyph, the headline and one sentence, then the fix. */
export function ProblemRow({ tone: name = 'danger', icon = 'alert', title, body, primary, secondary, detail, testId = 'problem' }: ProblemProps) {
  const t = useTheme()
  const details = useDetails(detail, testId)
  const c = toneOf(t, name)
  return (
    <Card testId={testId} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: c.fill(t.problem.rowFill), borderColor: c.edge(t.problem.rowEdge) }}>
      <Icon source={glyphSource(icon)} size={16} color={c.glyph} style={{ marginTop: 2 }} />
      <div role="alert" style={{ ...column, flexGrow: 1, flexShrink: 1, gap: 2 }}>
        <Label color={t.text} size={13} lineHeight={20} weight={500}>{title}</Label>
        {body && <Label color={t.problem.help} size={13} lineHeight={18}>{body}</Label>}
        {(primary || secondary || details.toggle) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 }}>
            {primary && <Button testId={primary.testId ?? `${testId}-primary`} size="sm" variant="primary" busy={primary.busy} onClick={primary.onClick}>{primary.label}</Button>}
            {secondary && <Button testId={secondary.testId ?? `${testId}-secondary`} size="sm" variant={primary ? 'secondary' : 'primary'} busy={secondary.busy} onClick={secondary.onClick}>{secondary.label}</Button>}
            {details.toggle}
          </div>
        )}
        {details.box && <div style={{ marginTop: 8 }}>{details.box}</div>}
      </div>
    </Card>
  )
}
