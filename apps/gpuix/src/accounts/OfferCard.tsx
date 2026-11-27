// Offer cards: on opening, one non-blocking card at the top right (never a dialog); the same offers stay listed on
// Settings › Accounts. "Not now" waits for the situation to change, "Never" ends it (`accounts_shared.offers`).
import { useWindowSize } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { RADIUS } from '../kit/controls.ts'
import { N } from '../nav/glyphs.ts'
import { useNav } from '../nav/store.ts'
import { surfaceShadow } from '../composer/Menu.tsx'
import { enterTransform, fadeTransform } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { REDUCED_MOTION, Label, useTheme } from '../ui.tsx'
import { frostBackdrop, settingsCardStyle, useGlass } from '../platform/glass.ts'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { PageBlock } from '../settings/controls.tsx'
import { useDialog } from '../dialogs/store.ts'
import { useFlow } from '../onboarding/flow.ts'
import { useIntro } from '../machines/intro.ts'
import { useApp } from '../state.ts'
import { AccountMarkStack } from '../usage/AccountMark.tsx'
import { acceptOffer, answerOffer } from './actions.ts'
import { nextCard, offerCopy, type Offer } from './offers.ts'
import { useAccountsEverywhere, useOffers, type UnifiedView } from './store.ts'

const nameOf = (view: UnifiedView) => (key: string) => view.groups.flatMap((g) => g.accounts).find((a) => a.key === key)?.name ?? view.shared.profiles?.[key]?.name ?? key.slice(key.indexOf(':') + 1)

/** The accounts an offer is about, as marks and names: what would change, without a sentence about it. */
function OfferAccounts({ offer, view }: { offer: Offer; view: UnifiedView }) {
  const t = useTheme()
  const accounts = view.groups.flatMap((g) => g.accounts).filter((a) => a.key && (offer.keys ?? []).includes(a.key))
  if (!accounts.length) return null
  const shown = accounts.slice(0, 3)
  const fill = t.variant === 'dark' ? 'rgba(252, 252, 252, 0.06)' : 'rgba(13, 13, 13, 0.05)'
  return <div testId={`offer-accounts-${offer.id}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
    {shown.map((account) => <div key={account.id} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 22, paddingLeft: 6, paddingRight: 8, borderRadius: RADIUS.sm - 2, backgroundColor: fill, maxWidth: 220 }}>
      <AccountMarkStack kind={account.kind} color={account.color} size={13} />
      <Label color={t.text} size={12} lineHeight={16} weight={500} truncate>{account.name}</Label>
    </div>)}
    {accounts.length > shown.length && <Label color={t.textSecondary} size={12} lineHeight={16}>{`+${accounts.length - shown.length}`}</Label>}
  </div>
}

// ── On opening ───────────────────────────────────────────────────────────────

const LAYER_BACKING = { blur: 0 }
/** After the app connects, the card waits this long so it never lands on the app's first frames. */
const SETTLE_MS = 1500
const handledThisRun = new Set<string>()

export function AccountOffersSurface({ settleMs = SETTLE_MS }: { settleMs?: number }) {
  const connected = useApp((s) => s.status === 'open')
  const onboarding = useFlow((s) => s.open || s.releasing)
  const intro = useIntro((s) => s.open)
  if (!connected || onboarding || intro) return null
  return <Opening settleMs={settleMs} />
}

function Opening({ settleMs }: { settleMs: number }) {
  const [settled, setSettled] = useState(settleMs <= 0)
  useEffect(() => { if (settled) return; const timer = setTimeout(() => setSettled(true), settleMs); return () => clearTimeout(timer) }, [])
  return settled ? <Cards /> : null
}

function Cards() {
  const view = useAccountsEverywhere()
  const { offers, ready } = useOffers(view)
  const dialog = useDialog()
  const settings = useNav((s) => s.settingsOpen)
  const [, setHandled] = useState(0)
  const offer = ready ? nextCard(offers, handledThisRun) : null
  const handle = (taken: Offer) => { handledThisRun.add(`${taken.id}:${taken.fingerprint}`); setHandled((n) => n + 1) }
  // Never over a dialog, and not on Settings, whose Accounts page lists the same offers.
  const show = !!offer && !dialog && !settings
  const size = useWindowSize({ intervalMs: 500 })
  const [last, setLast] = useState<Offer | null>(offer)
  if (offer && offer !== last) setLast(offer)
  const card = offer ?? last
  if (!card) return null
  // The layer takes the card's radius and no blur of its own, as the toasts' layers do: without it the corners paint black.
  return <anchored position={{ x: size.width - 12, y: 54 }} anchor="topRight" fit="snap" snapMargin={8} deferred priority={4} occlude={show} backdrop={LAYER_BACKING} style={{ borderRadius: RADIUS.xl }}>
    <Presence show={show} enter={REDUCED_MOTION ? fadeTransform() : { ...enterTransform('panel')!, initial: { opacity: 0, translateY: -8 } }} exit={{ to: { opacity: 0, translateY: -8 }, duration: 0.15 }}>
      <OfferCard key={card.id} offer={card} view={view}
        onAccept={(answer) => { handle(card); void acceptOffer(view, card, answer) }}
        onLater={() => { handle(card); void answerOffer(card, 'later') }}
        onNever={() => { handle(card); void answerOffer(card, 'never') }} />
    </Presence>
  </anchored>
}

export function OfferCard({ offer, view, onAccept, onLater, onNever }: { offer: Offer; view: UnifiedView; onAccept: (answer: 'accept' | 'change') => void; onLater: () => void; onNever: () => void }) {
  const t = useTheme()
  const g = useGlass()
  const copy = offerCopy(offer, nameOf(view))
  const clash = offer.kind === 'migration_clash'
  // The toast's material: frosted in a glass window (no shadow under a translucent fill), else the popover surface.
  return <div testId={`offer-card-${offer.kind}`} role="status" aria-label={copy.title} backdrop={frostBackdrop(g, 'pills', RADIUS.xl)} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 340, padding: 14, borderRadius: RADIUS.xl, borderWidth: 1, borderColor: g.on ? g.frostRim : t.border, backgroundColor: g.on ? g.denseFloat : t.popover, ...(g.on ? {} : { boxShadow: surfaceShadow(t) }) }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Label color={t.text} size={14} lineHeight={20} weight={600}>{copy.title}</Label>
      {copy.body && <Label color={t.textSecondary} size={13} lineHeight={19}>{copy.body}</Label>}
    </div>
    <OfferAccounts offer={offer} view={view} />
    {clash
      ? <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button testId="offer-change" size="sm" onClick={() => onAccept('change')}>{copy.alternative!}</Button>
        <Button testId="offer-accept" size="sm" variant="primary" onClick={() => onAccept('accept')}>{copy.action}</Button>
      </div>
      : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button testId="offer-never" size="sm" variant="ghost" onClick={onNever} style={{ marginLeft: -8 }}>Never</Button>
        <div style={{ flexGrow: 1 }} />
        <Button testId="offer-later" size="sm" variant="ghost" onClick={onLater}>Not now</Button>
        <Button testId="offer-accept" size="sm" variant="primary" onClick={() => onAccept('accept')}>{copy.action}</Button>
      </div>}
  </div>
}

// ── On the Accounts page ─────────────────────────────────────────────────────

export function OfferRows({ offers, view }: { offers: readonly Offer[]; view: UnifiedView }) {
  const t = useTheme()
  const g = useGlass()
  return <PageBlock><div testId="accounts-offers" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 30 }}>
    <div style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
      {offers.map((offer, index) => {
        const copy = offerCopy(offer, nameOf(view))
        return <div key={offer.id} testId={`offer-row-${offer.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 12, paddingTop: 12, paddingBottom: 12, borderTopWidth: index ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            <Label color={t.text} size={14} lineHeight={21} weight={500}>{copy.title}</Label>
            <OfferAccounts offer={offer} view={view} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {copy.alternative && <Button testId={`offer-row-change-${offer.id}`} size="sm" onClick={() => void acceptOffer(view, offer, 'change')}>{copy.alternative}</Button>}
            <Button testId={`offer-row-accept-${offer.id}`} size="sm" onClick={() => void acceptOffer(view, offer, 'accept')}>{copy.action}</Button>
            {offer.kind !== 'migration_clash' && <IconButton testId={`offer-row-never-${offer.id}`} size="sm" icon={N.x} label="Don’t suggest this again" onClick={() => void answerOffer(offer, 'never')} />}
          </div>
        </div>
      })}
    </div>
  </div></PageBlock>
}
