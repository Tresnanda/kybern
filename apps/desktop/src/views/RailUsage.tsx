// Plan usage at a glance, in the app rail above Settings: one ring per provider,
// filled with what is left of its tightest limit. Hovering a ring opens that
// provider's card; moving to the next ring carries the same card over without
// closing it (one shared popover, per the HIG's one-popover-at-a-time rule).
// Opening asks the daemon to re-read, so the numbers are current when looked at.
// The card never scrolls, so the resize between providers shows no scrollbar.
// Each ring sits in the same 36px button and 6px gap as the rail's destinations,
// at 24px so its weight reads like their 18px icons rather than crowding them.
// When a read fails the card says why and what brings the numbers back, and a
// window that reset since its last reading shows no number rather than "100% left".

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { AccountDot, AccountMarkStack } from "@/components/kybern/accounts/AccountMark"
import { openAddAccount } from "@/components/kybern/accounts/AddAccountSheet"
import { ProviderMark } from "@/components/kybern/bits"
import { LimitMeter } from "@/components/kybern/LimitMeter"
import { accountsOfKind, limitsForAccount } from "@/lib/accountUi"
import { CLI_INSTANCE, isCliInstance } from "@/lib/accounts"
import { useNow } from "@/lib/hooks"
import { CheckIcon, PlusIcon } from "@/lib/kit/icons"
import { PROVIDER_NAMES, bindingLimit, limitLabel, limitLeftLabel, limitPace, limitTone, limitUsed, limitsStale, resetIn, staleReason, updatedAgo } from "@/lib/providerUsage"
import { cn } from "@/lib/utils"
import type { AccountSummary, ProviderKind, ProviderLimits } from "@/protocol"
import { refreshAccounts, updateProviderSettings, useAccounts, useDefaultAccount } from "@/state/accounts"
import { errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { refreshUsageLimits, useAccountLimitEntries, useAccountLimits, useProviderLimits, useRefreshingLimits } from "@/state/usageLimits"

const usageCard = PopoverCreateHandle<ProviderKind>()

export function RailUsage() {
  const providers = useAccountLimits()
  const now = useNow(60_000)
  // A provider whose every window reset since it was read keeps its ring, empty and dimmed.
  const glance = providers.flatMap((entry) => (entry.limits.length > 0 ? [{ entry, used: bindingLimit(entry.limits, now)?.used ?? null }] : []))
  if (glance.length === 0) return null
  return (
    <div role="group" aria-label="Plan usage" className="flex flex-col items-center gap-1.5">
      {glance.map(({ entry, used }) => {
        const name = PROVIDER_NAMES[entry.provider] ?? entry.provider
        return (
          <PopoverTrigger
            key={entry.provider}
            handle={usageCard}
            payload={entry.provider}
            openOnHover
            delay={80}
            closeDelay={100}
            render={
              <button
                type="button"
                aria-label={used === null ? `${name}: not read since reset` : `${name}: ${Math.round(100 - used)}% left`}
                data-testid={`rail-usage-${entry.provider}`}
                className="press relative inline-flex size-9 cursor-pointer items-center justify-center rounded-[10px] outline-hidden hover:bg-[var(--app-rail-hover)] focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-[var(--app-rail-hover)]"
              />
            }
          >
            <DefaultRing kind={entry.provider} left={used === null ? null : 100 - used} tone={limitTone(used)} stale={used === null || limitsStale(entry, now)} />
          </PopoverTrigger>
        )
      })}
      <Popover handle={usageCard}>
        {({ payload }) => (
          <PopoverPopup side="right" align="end" sideOffset={8} scrollable={false} className="w-80 font-system-ui">
            {payload && <AccountsUsageCard kind={payload} />}
          </PopoverPopup>
        )}
      </Popover>
    </div>
  )
}

/** The ring of the default account; a colored default also wears its dot. */
function DefaultRing({ kind, left, tone, stale }: { kind: ProviderKind; left: number | null; tone: ReturnType<typeof limitTone>; stale: boolean }) {
  const color = useDefaultAccount(kind)?.color
  return <UsageRing kind={kind} left={left} tone={tone} stale={stale} color={color} />
}

function UsageRing({ kind, left, tone, stale, color }: { kind: ProviderKind; left: number | null; tone: ReturnType<typeof limitTone>; stale: boolean; color?: string | null }) {
  return (
    <span className="rail-usage-ring" data-usage-tone={tone} data-stale={stale || undefined}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-6 -rotate-90" fill="none">
        <circle cx="12" cy="12" r="10.25" strokeWidth="2" className="rail-usage-track" />
        {left !== null && <circle cx="12" cy="12" r="10.25" strokeWidth="2" pathLength="100" strokeDasharray="100 100" strokeDashoffset={100 - left} strokeLinecap="round" className="rail-usage-arc" />}
      </svg>
      <ProviderMark kind={kind} size={11} className="absolute" />
      {/* Beside the ring at its top-right, clear of the arc. */}
      <AccountDot color={color} className="absolute -end-1 -top-1" />
    </span>
  )
}

/** What is left of an account's tightest limit, as a percentage, or null when nothing is known. */
function leftOf(entry: ProviderLimits | undefined, now: number): number | null {
  const binding = entry ? bindingLimit(entry.limits, now) : null
  return binding ? 100 - binding.used : null
}

function AccountsUsageCard({ kind }: { kind: ProviderKind }) {
  const global = useProviderLimits(kind)
  const entries = useAccountLimitEntries()
  const refreshing = useRefreshingLimits().includes(kind)
  const accounts = accountsOfKind(useAccounts(kind), kind)
  const now = useNow(15_000)
  const [changed, setChanged] = useState(false)
  const changedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Named accounts are read only while this card is open.
  useEffect(() => {
    refreshUsageLimits({ allAccounts: true })
    void refreshAccounts()
  }, [kind])
  useEffect(() => () => clearTimeout(changedTimer.current), [])
  const defaultAccount = accounts.find((account) => account.is_default) ?? accounts[0]
  const limitsOf = (account: AccountSummary) => limitsForAccount(account, entries, global ? [global] : [])
  const entry = (defaultAccount ? limitsOf(defaultAccount) : undefined) ?? global
  const choose = async (account: AccountSummary) => {
    if (account.is_default) return
    try {
      await updateProviderSettings(kind, (current) => ({ ...current, default_account: isCliInstance(account.provider.instance) ? null : account.provider.instance }))
      setChanged(true)
      clearTimeout(changedTimer.current)
      changedTimer.current = setTimeout(() => setChanged(false), 2000)
    } catch (error) {
      toast.error("Unable to change the default account", { description: `${errorText(error)} Check your connection, then try again.` })
    }
  }
  const name = PROVIDER_NAMES[kind] ?? kind
  const reason = entry ? staleReason(entry, now) : null
  return (
    <div className="provider-usage-content flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ProviderMark kind={kind} size={14} />
        <PopoverTitle className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,13px)] font-medium leading-snug">{name}</PopoverTitle>
        <button type="button" onClick={() => useStore.getState().selectUsage()} className="press-row shrink-0 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">Usage details</button>
      </div>
      {accounts.length > 1 && (
        <div role="radiogroup" aria-label={`Default ${name} account`} className="-mx-1.5 flex flex-col gap-px">
          {accounts.map((account) => (
            <AccountRow key={account.provider.instance} account={account} left={leftOf(limitsOf(account), now)} onChoose={() => void choose(account)} />
          ))}
        </div>
      )}
      <div aria-live="polite" className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground empty:hidden">{changed ? "Default changed" : null}</div>
      {entry && entry.limits.length > 0 && (
        <div className="flex flex-col gap-3">
          {entry.limits.map((limit) => <LimitRow key={`${limit.window_minutes ?? ""}-${limit.name}`} limit={limit} kind={kind} now={now} />)}
        </div>
      )}
      {entry && (
        <div className="flex flex-col gap-0.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground" aria-live="polite">
          <p>{freshness(entry, refreshing, now)}</p>
          {!refreshing && reason && <p>{reason}</p>}
        </div>
      )}
      <div aria-hidden className="-mx-1 h-px bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]" />
      <div className="-my-1 flex items-center justify-between gap-3">
        <button type="button" onClick={() => useStore.getState().set({ settingsOpen: true, settingsTab: "accounts" })} className="press-row rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">Manage accounts…</button>
        <button type="button" onClick={() => openAddAccount({ kind })} className="press-row inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          <PlusIcon className="size-3" aria-hidden />Add account
        </button>
      </div>
    </div>
  )
}

function AccountRow({ account, left, onChoose }: { account: AccountSummary; left: number | null; onChoose: () => void }) {
  const kind = account.provider.kind
  const cli = account.provider.instance === CLI_INSTANCE
  const needsSignIn = !cli && (account.status === "needs_sign_in" || account.status === "signed_out")
  const email = account.identity?.email ?? account.identity?.plan ?? null
  const body = (
    <>
      <AccountMarkStack kind={kind} color={cli ? null : account.color} size={14} />
      <span className="min-w-0 flex-1 text-start">
        <span className="block truncate"><bdi>{account.name}</bdi></span>
        {email && <span className="block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{email}</span>}
      </span>
    </>
  )
  const rowClass = cn("flex items-center gap-2.5 rounded-[0.5rem] px-1.5 py-1.5", account.is_default && "bg-[var(--color-background-button-secondary)]")
  const radioClass = "press-row flex min-w-0 flex-1 items-center gap-2.5 rounded-[0.5rem] text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
  if (needsSignIn) {
    return (
      <div className={rowClass}>
        <button type="button" role="radio" aria-checked={false} aria-disabled className={cn(radioClass, "cursor-default opacity-70")}>{body}</button>
        <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">Needs sign-in</span>
        <button type="button" onClick={() => openAddAccount({ kind, instance: account.provider.instance })} className="press-row shrink-0 rounded-sm text-[length:var(--app-font-size-ui-sm,11px)] font-medium outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring">Sign in</button>
      </div>
    )
  }
  return (
    <button type="button" role="radio" aria-checked={account.is_default} onClick={onChoose} className={cn(rowClass, "w-full cursor-pointer outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring", !account.is_default && "hover:bg-[var(--color-background-button-secondary-hover)]")}>
      {body}
      <span className="flex min-w-12 shrink-0 flex-col items-end gap-1 whitespace-nowrap text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
        {left !== null ? <><span>{Math.round(left)}% left</span><span className="w-12"><LimitMeter left={left} pace={null} label={`${account.name} left`} /></span></> : <span aria-hidden>—</span>}
      </span>
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>{account.is_default && <CheckIcon className="size-3.5" />}</span>
    </button>
  )
}

function LimitRow({ limit, kind, now }: { limit: ProviderLimits["limits"][number]; kind: ProviderKind; now: number }) {
  const used = limitUsed(limit, now)
  const name = limitLabel(limit, kind)
  const left = used === null ? null : 100 - used
  const pace = limitPace(limit, now)
  return (
    <div data-usage-tone={limitTone(used)}>
      <div className="mb-0.5 flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{limitLeftLabel(limit, now)}</span>
      </div>
      {left !== null && <LimitMeter left={left} pace={pace} label={`${name} left`} />}
      <div className="mt-0.5 flex items-baseline justify-between gap-3 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
        <span className="min-w-0 truncate">{resetIn(limit.resets_at, now)}</span>
        {pace && <span className="shrink-0" data-pace-short={pace.short || undefined}>{pace.label}</span>}
      </div>
    </div>
  )
}

function freshness(entry: ProviderLimits, refreshing: boolean, now: number): string {
  if (refreshing) return "Updating…"
  const ago = updatedAgo(entry.updated_at, now)
  if (!ago) return ""
  return limitsStale(entry, now) ? `Last updated ${ago}` : `Updated ${ago}`
}
