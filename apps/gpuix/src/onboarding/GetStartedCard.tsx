// The Get-started card on Home (v1 SPEC §9): what the first run left to do, at the top of the Draft's column. A header (title,
// "1 of 5 done", one bar per item, Hide, a chevron) over a list of items, each with an icon well, a sentence and one verb.
// An item that gets done cross-fades its icon to a check that draws in, goes quiet, and its button leaves.
//
// The card is in the Draft's flow, above the centred block. Hiding it, or folding its list, changes the card's height, and the
// Draft (everything under the card) glides by 13/20 of that change in a retained translation (`GlideBox`): the layout jumps once,
// the paint starts where it was and settles. Heights are fixed on purpose (rows are one line), so the glide needs no measuring.
import { MonitorSmartphoneIcon } from '@hugeicons/core-free-icons'
import { useWindowSize } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { glyph, Icon, ICONS as KIT } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { EASE } from '../motion/tokens.ts'
import { strokeDraw } from '../motion/success.ts'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { N } from '../nav/glyphs.ts'
import { useNav } from '../nav/store.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { notifications } from '../native/notifications.ts'
import { onWindowVisibility } from '../native/visibility.ts'
import { openSettingsTab } from '../settings/SettingsScreen.tsx'
import { S } from '../settings/glyphs.ts'
import { useEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { useAccounts, useAccountsFeed } from '../usage/accounts.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { agentFor, agents } from './agentsStore.ts'
import { allDone, defaultExpanded, ITEM_COPY, progressLabel, visibleItems, type Item, type ItemCopy, type ItemId } from './getStarted.ts'
import { hideCard, refreshFacts, setExpanded, useGetStarted } from './getStartedStore.ts'
import { openProjectsOnly } from './flow.ts'
import { resetProjects } from './projectsStore.ts'
import { AGENT_ORDER } from './model.ts'
import { bez, riseTransform } from './motion.tsx'
import { isFresh } from './Handoff.tsx'

// Fixed geometry: the glide depends on these heights, so none of them may wrap or measure.
const HEADER_H = 52
const ROW_H = 56
const LIST_PAD = 8
const BORDER = 1
const SLOT_TOP = 16
const SLOT_BOTTOM = 8
const itemsHeight = (n: number) => n * ROW_H + LIST_PAD
const cardHeight = (n: number, expanded: boolean) => BORDER * 2 + HEADER_H + (expanded ? itemsHeight(n) : 0)
const slotHeight = (n: number, expanded: boolean) => SLOT_TOP + cardHeight(n, expanded) + SLOT_BOTTOM

const PHONE = glyph(MonitorSmartphoneIcon)
const ICONS: Record<ItemCopy['icon'], string> = { agent: KIT.bot, terminal: S.terminal, phone: PHONE, computer: N.laptop, bell: N.bell, import: N.clock }
const CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><path d="M5.252 12.7 10.2 18.63 18.748 5.37"/></svg>'

/** Press the verb: where each item goes. A thing the machine answers (notifications) asks first and falls back to its settings. */
const ACT: Record<ItemId, () => void> = {
  agent: () => openSettingsTab('agents'),
  cli: () => openSettingsTab('about'),
  phone: () => showEnvironmentDialog({ kind: 'pair' }),
  computer: () => openSettingsTab('computer'),
  notifications: () => {
    void notifications.requestPermission().then((state) => { if (state !== 'granted') openSettingsTab('notifications') }, () => openSettingsTab('notifications'))
  },
  import: () => { resetProjects(); openProjectsOnly() },
}
const canPair = () => !!getClient()?.info?.scopes.includes('access_write')

/** The agents the machine has ready now (the card's own read: Home does not run the flow's detection). */
function useAgentReady(): boolean | null {
  const providers = useNav((s) => s.providers)
  const loaded = useNav((s) => s.providersLoaded)
  const accounts = useAccounts()
  const cursor = agents.use((s) => s.cursor)
  useAccountsFeed()
  if (!loaded) return null
  return AGENT_ORDER.some((kind) => agentFor(kind, providers, accounts, cursor, loaded).state === 'ready')
}

/** The card's items and size, from the store and the machine. */
function useCardModel() {
  const state = useGetStarted((s) => s)
  const env = useEnvironment()
  const size = useWindowSize({ intervalMs: 500 })
  const agentReady = useAgentReady()
  const items = visibleItems(process.platform, state.needs, { ...state.facts, agentReady, importDone: state.importDone })
  const expanded = state.expanded ?? defaultExpanded(size?.height ?? 900)
  const shown = state.exists && !state.hidden && env.local && items.length > 0
  return { state, items, expanded, shown }
}

// ─── The glide ────────────────────────────────────────────────────────────

/** Everything under the card. When the card changes height the content starts where it was and settles on the kit spring. */
export function GlideBox({ children, still = false }: { children: ReactNode; still?: boolean }) {
  const glide = useGetStarted((s) => s.glide)
  const motion = !still && PATCHED_NATIVE && !REDUCED_MOTION && glide.generation > 0 && glide.from !== 0
    ? { initial: { translateX: 0, translateY: glide.from }, animate: { translateX: 0, translateY: 0 }, transition: { type: 'spring' as const, duration: 0.5, bounce: 0 }, generation: glide.generation }
    : undefined
  return <div paintTranslate={motion} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>{children}</div>
}

// ─── The card ─────────────────────────────────────────────────────────────

const HIDE_MS = 350
const FOLD_MS = 150

/** The card's slot at the top of the Draft; empty when there is no card. `slotRef` gives the Draft its box for the send transition. */
export function GetStartedSlot({ slotRef }: { slotRef?: (node: import('@gpuix/react').PublicInstance | null) => void }) {
  const { state, items, expanded, shown } = useCardModel()
  const [leaving, setLeaving] = useState<'hide' | 'fold' | null>(null)
  const enter = useRef(isFresh()).current

  // Read the machine on arrival, when the window comes back, when Settings closes, and slowly while something is still open.
  const settingsOpen = useNav((s) => s.settingsOpen)
  useEffect(() => { if (shown) void refreshFacts() }, [shown, settingsOpen])
  useEffect(() => {
    if (!shown) return
    let visible = true
    const stop = onWindowVisibility((now) => { visible = now; if (now) void refreshFacts() })
    const timer = setInterval(() => { if (visible) void refreshFacts() }, 10_000)
    return () => { stop(); clearInterval(timer) }
  }, [shown])

  const n = items.length
  const hide = () => {
    if (leaving) return
    const change = -slotHeight(n, expanded)
    setLeaving('hide')
    setTimeout(() => hideCard(change), REDUCED_MOTION ? 120 : HIDE_MS)
  }
  const fold = () => {
    if (leaving) return
    if (!expanded) { setExpanded(true, itemsHeight(n)); return }
    setLeaving('fold')
    setTimeout(() => { setExpanded(false, -itemsHeight(n)); setLeaving(null) }, REDUCED_MOTION ? 80 : FOLD_MS)
  }
  // Everything done: let the last tick land, then the card hides itself.
  const complete = state.factsReady && allDone(items)
  useEffect(() => {
    if (!shown || !complete) return
    const timer = setTimeout(hide, 2400)
    return () => clearTimeout(timer)
  }, [shown, complete])

  if (!shown) return null
  return (
    <div ref={slotRef} testId="get-started-slot" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: '100%', paddingTop: SLOT_TOP, paddingBottom: SLOT_BOTTOM }}>
      <Card items={items} expanded={expanded} leaving={leaving} enter={enter} factsReady={state.factsReady} onHide={hide} onFold={fold} />
    </div>
  )
}

function cardMotion(leaving: 'hide' | 'fold' | null, enter: boolean): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION) return { initial: enter ? { opacity: 0 } : false, animate: { opacity: leaving === 'hide' ? 0 : 1 }, transition: { duration: 0.15, ease: bez(EASE.out) }, retain: true }
  const hiding = leaving === 'hide'
  return {
    initial: enter ? { opacity: 0, translateY: 12, blur: 4 } : false,
    animate: hiding ? { opacity: 0, scale: 0.98, blur: 4, translateY: 0 } : { opacity: 1, scale: 1, blur: 0, translateY: 0 },
    transition: { duration: hiding ? HIDE_MS / 1000 : 0.5, delay: hiding ? 0 : enter ? 0.95 : 0, ease: bez(EASE.out) },
    origin: [0.5, 0],
    retain: true,
  }
}

function Card({ items, expanded, leaving, enter, factsReady, onHide, onFold }: { items: Item[]; expanded: boolean; leaving: 'hide' | 'fold' | null; enter: boolean; factsReady: boolean; onHide: () => void; onFold: () => void }) {
  const t = useTheme()
  const open = expanded && leaving !== 'fold'
  const mountList = expanded
  return (
    <div
      testId="get-started"
      role="region"
      aria-label="Get started"
      paintTransform={cardMotion(leaving, enter)}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 736, borderRadius: 16, borderWidth: BORDER, borderColor: t.cardEdge, backgroundColor: t.surface, ...(leaving === 'hide' ? { pointerEvents: 'none' as const } : {}) }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, height: HEADER_H, paddingLeft: 18, paddingRight: 10 }}>
        <Label color={t.text} size={14} lineHeight={20} weight={600} style={{ whiteSpace: 'nowrap' }}>Get started</Label>
        <Label color={t.textSecondary} size={13} lineHeight={20} style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as never}>{progressLabel(items)}</Label>
        <Bars items={items} />
        <div style={{ flexGrow: 1 }} />
        <Button testId="get-started-hide" variant="ghost" size="sm" onClick={onHide}>Hide</Button>
        <IconButton testId="get-started-fold" label={open ? 'Collapse Get started' : 'Expand Get started'} icon={N.chevronDown} onClick={onFold}>
          <Chevron open={open} turn={180} source={N.chevronDown} size={14} color={t.iconSecondary} />
        </IconButton>
      </div>
      {mountList && (
        <div
          role="list"
          aria-label="Setup items"
          paintTransform={PATCHED_NATIVE && !REDUCED_MOTION ? { initial: factsReady ? { opacity: 0, translateY: -6 } : false, animate: leaving === 'fold' ? { opacity: 0, translateY: -4 } : { opacity: 1, translateY: 0 }, transition: { duration: leaving === 'fold' ? FOLD_MS / 1000 : 0.25, ease: bez(EASE.out) }, retain: true } : undefined}
          style={{ display: 'flex', flexDirection: 'column', paddingBottom: LIST_PAD }}
        >
          {items.map((item) => <Row key={item.id} item={item} factsReady={factsReady} />)}
        </div>
      )}
    </div>
  )
}

/** One 14×4 bar per item: it fills on `scaleX` when its item is done. */
function Bars({ items }: { items: Item[] }) {
  const t = useTheme()
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
      {items.map((item) => (
        <div key={item.id} style={{ position: 'relative', width: 14, height: 4, borderRadius: 2, backgroundColor: t.variant === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(13, 13, 13, 0.1)', overflow: 'hidden' }}>
          <div
            paintTransform={PATCHED_NATIVE ? { initial: false, animate: { scaleX: item.done ? 1 : 0.001, opacity: item.done ? 1 : 0 }, transition: { duration: REDUCED_MOTION ? 0.15 : 0.5, ease: bez(EASE.out) }, origin: [0, 0.5], retain: true } : undefined}
            style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 2, backgroundColor: t.text, ...(PATCHED_NATIVE ? {} : { opacity: item.done ? 1 : 0 }) }}
          />
        </div>
      ))}
    </div>
  )
}

function Row({ item, factsReady }: { item: Item; factsReady: boolean }) {
  const t = useTheme()
  const copy = ITEM_COPY[item.id]
  const { done } = item
  // A tick that arrives while the card is on screen is news and plays; one that was already true when the machine was first read is not.
  const was = useRef<boolean | null>(null)
  const news = factsReady && was.current === false && done
  was.current = factsReady ? done : null
  const [played, setPlayed] = useState(false)
  if (news && !played) setPlayed(true)
  const draw = played && !REDUCED_MOTION
  const fade = (visible: boolean, extra: Record<string, number> = {}): PaintTransformProps | undefined =>
    PATCHED_NATIVE ? { initial: false, animate: REDUCED_MOTION ? { opacity: visible ? 1 : 0 } : { opacity: visible ? 1 : 0, ...(visible ? { scale: 1 } : extra) }, transition: { duration: REDUCED_MOTION ? 0.15 : 0.3, ease: bez(EASE.out) }, retain: true } : undefined
  const pair = item.id === 'phone' && !canPair()
  return (
    <div testId={`get-started-${item.id}`} role="listitem" aria-label={done ? `${copy.title}, done` : copy.title} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, height: ROW_H, paddingLeft: 18, paddingRight: 14 }}>
      <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0, borderRadius: 10, backgroundColor: t.buttonSecondary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div paintTransform={fade(!done, { scale: 0.8 })} style={{ position: 'absolute', display: 'flex', pointerEvents: 'none' }}>
          <Icon source={ICONS[copy.icon]} size={16} color={t.textSecondary} />
        </div>
        {done && (
          <div
            key={played ? 'drawn' : 'rest'}
            paintTransform={PATCHED_NATIVE ? { initial: draw ? { opacity: 0, scale: 0.8 } : false, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.3, ease: bez(EASE.out) } } : undefined}
            style={{ position: 'absolute', display: 'flex', pointerEvents: 'none' }}
          >
            <svg source={CHECK} {...(draw ? { paintAnimation: strokeDraw(24, 80) } : {})} style={{ width: 16, height: 16, color: t.textSecondary, pointerEvents: 'none' }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <Label color={done ? t.textTertiary : t.text} size={14} lineHeight={20} weight={500} truncate>{copy.title}</Label>
        <Label color={t.textTertiary} size={13} lineHeight={18} truncate>{copy.description}</Label>
      </div>
      <div paintTransform={fade(!done, { scale: 0.96 })} style={{ display: 'flex', flexShrink: 0, ...(done ? { pointerEvents: 'none' as const } : {}) }}>
        <Button testId={`get-started-${item.id}-act`} size="sm" variant="secondary" disabled={done || pair} onClick={() => ACT[item.id]()}>{copy.button}</Button>
      </div>
    </div>
  )
}
