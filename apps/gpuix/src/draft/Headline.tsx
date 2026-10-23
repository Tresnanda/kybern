// The new chat's headline (ADE-62 round 2, variant "Title"): a small line saying what is about to happen ("Let's work in"),
// and the project as the hero, which is the project picker. Long names step down 34 → 28 → 24 pt by length, then truncate with
// the full name in a tooltip. Free chat reads "Free chat"; its menu switches to a project.
import { useState } from 'react'
import { COORDINATOR_DRAFT_HINT } from '../../../../packages/kybern-client/src/coordinator.ts'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { G } from '../composer/glyphs.ts'
import { PickerItem, PickerMenu, PickerSeparator } from '../composer/Menu.tsx'
import { RADIUS } from '../kit/controls.ts'
import { Swap } from '../motion/kit.tsx'
import { Tip } from '../nav/overlay.tsx'
import { COLUMN } from '../Transcript.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { heroChevron, heroType } from './model.ts'

/** The hero's height: 46 at every type size, so a project change never moves the composer. */
export const HERO_HEIGHT = 46

export function Headline({ projects, projectId, name, coordinator, onPick, frozen = false }: {
  projects: Project[]
  projectId: string | null
  /** The project's name, or null for a free chat. */
  name: string | null
  coordinator: boolean
  onPick: (id: string | null) => void
  /** A frozen copy (the send transition's exit layer): no menu. */
  frozen?: boolean
}) {
  const t = useTheme()
  const label = name ?? 'Free chat'
  const hero = (open: boolean) => <HeroTrigger name={label} open={open} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      <Label color={t.textTertiary} size={13} lineHeight={18} weight={500}>
        {coordinator ? 'Let’s coordinate in' : 'Let’s work in'}
      </Label>
      <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 4, height: HERO_HEIGHT }}>
        {frozen ? hero(false) : (
          <PickerMenu
            testId="heading-project"
            side="bottom"
            align="center"
            // GPUIX puts a centred layer's far edge on the trigger's centre (`Tip`): half the width brings it back.
            alignOffset={170}
            sideOffset={6}
            width={340}
            rootStyle={{ maxWidth: COLUMN - 48 }}
            trigger={(open) => [...label].length > 40
              ? <Tip label={label} side="bottom" size={Math.min(COLUMN - 48, [...label].length * 13)}><div style={{ display: 'flex', minWidth: 0 }}>{hero(open)}</div></Tip>
              : hero(open)}
          >
            {projects.map((p) => (
              <PickerItem key={p.id} id={p.id} testId={`heading-project-${p.id}`} onSelect={() => onPick(p.id)}>
                <Icon name="folder" size={18} color={t.text} style={{ opacity: 0.8 }} />
                <Label color={t.text} truncate style={{ flexGrow: 1 }}>{p.name}</Label>
                {p.id === projectId && <Icon source={G.checkBold} size={14} color={t.text} />}
              </PickerItem>
            ))}
            {/* A Coordinator always has a project. */}
            {!coordinator && <PickerSeparator />}
            {!coordinator && (
              <PickerItem id="free" testId="heading-project-free" onSelect={() => onPick(null)}>
                <Icon source={G.message} size={18} color={t.text} style={{ opacity: 0.8 }} />
                <Label color={t.text} truncate style={{ flexGrow: 1 }}>Free chat</Label>
                {!projectId && <Icon source={G.checkBold} size={14} color={t.text} />}
              </PickerItem>
            )}
          </PickerMenu>
        )}
      </div>
      {coordinator && (
        <div style={{ display: 'flex', marginTop: 10 }}>
          <Label color={ink(t, 0.6)} size={13} lineHeight={18}>{COORDINATOR_DRAFT_HINT}</Label>
        </div>
      )}
    </div>
  )
}

/** A chevron-down drawn for the hero, cropped to its ink (16 × 9), so the gap and centring are the glyph's own; its stroke
 *  follows the 600-weight stems instead of the 1.5 of the 24 px icon set. `stroke` is in points at `width`. */
const chevronSvg = (width: number, stroke: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" fill="none"><path d="M1.75 1.75 8 7.25 14.25 1.75" stroke="currentColor" stroke-width="${(stroke * 16) / width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/**
 * The hero picker's trigger (spec: 46 tall, 0 10 0 14, `RADIUS.lg`): hug-width, so a project change swaps the label with the
 * kit's `Swap` and never tweens a width. Hover and open fill with the ink wash; no press scale (it is a wide control).
 */
function HeroTrigger({ name, open }: { name: string; open: boolean }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const { size, lineHeight } = heroType(name)
  const chevron = heroChevron(size)
  const fill = ink(t, t.variant === 'dark' ? 0.07 : 0.055)
  return (
    <div
      testId="draft-hero"
      aria-label={`Project: ${name}. Change project`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: chevron.gap,
        height: HERO_HEIGHT,
        minWidth: 0,
        maxWidth: COLUMN - 48,
        paddingLeft: 14,
        paddingRight: 10,
        borderRadius: RADIUS.lg,
        cursor: 'pointer',
        backgroundColor: open ? fill : 'rgba(0, 0, 0, 0)',
        hover: { backgroundColor: fill },
      }}
    >
      <Swap active={name} still innerStyle={{ minWidth: 0 }} style={{ minWidth: 0, flexShrink: 1, justifyContent: 'flex-start' }}>
        <Label color={t.text} size={size} lineHeight={lineHeight} weight={600} truncate>{name}</Label>
      </Swap>
      {/* Centred on the lowercase body (baseline to x-height), not the line box: `nudge` points down from the box's centre. */}
      <svg
        testId="draft-hero-chevron"
        source={chevronSvg(chevron.width, chevron.stroke)}
        style={{ width: chevron.width, height: (chevron.width * 9) / 16, flexShrink: 0, marginTop: chevron.nudge * 2, color: hover || open ? t.textSecondary : t.textTertiary, pointerEvents: 'none' }}
      />
    </div>
  )
}
