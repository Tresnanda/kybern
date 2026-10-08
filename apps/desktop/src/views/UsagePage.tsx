import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/kit/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/kit/input-group"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ProviderMark } from "@/components/kybern/bits"
import { LimitMeter } from "@/components/kybern/LimitMeter"
import { ChevronDownIcon, RefreshCwIcon } from "@/lib/kit/icons"
import { tokens, usd } from "@/lib/format"
import { useNow } from "@/lib/hooks"
import { PROVIDER_NAMES, limitLabel, limitLeftLabel, limitPace, limitTone, limitUsed, limitsStale, resetIn, staleReason, updatedAgo } from "@/lib/providerUsage"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import { takeUsageAnchor } from "@/state/accounts"
import { refreshUsageLimits, useAccountLimits, useRefreshingLimits } from "@/state/usageLimits"
import { SurfaceHeader } from "./chrome"
import type { ProviderKind, UsageGroup, UsageSummaryResult } from "@/protocol"

type Period = "7" | "30" | "all"
const PERIODS: Record<Period, string> = { "7": "Last 7 days", "30": "Last 30 days", all: "All time" }
const dayLabel = (key: string, includeYear = false) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC", ...(includeYear ? { year: "numeric" } as const : {}) })
const count = (row: UsageSummaryResult["total"]) => row.usage.input_tokens + row.usage.output_tokens

export function UsagePage() {
  const environmentId = useStore((s) => s.environmentId)
  const connection = useStore((s) => s.connection.state)
  // Account limits come from the daemon's shared cache and update live
  // (see state/usageLimits.ts); this page only renders them.
  const limitProviders = useAccountLimits()
  const limitsRefreshing = useRefreshingLimits().length > 0
  const now = useNow(15_000)
  const [period, setPeriod] = useState<Period>("30")
  const [group, setGroup] = useState<UsageGroup>("provider")
  const [revision, refresh] = useState(0)
  const [rowLimit, setRowLimit] = useState(20)
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [result, setResult] = useState<{ key: string; scope: string; summary: UsageSummaryResult; days: UsageSummaryResult; end: string } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const scope = `${environmentId}:${connection}:${period}:${group}`
  const key = `${scope}:${revision}`
  // A finished turn adds to the totals: reload them quietly, keeping the
  // current figures on screen and any error to an explicit refresh.
  const running = useStore((s) => Object.values(s.threads).reduce((n, thread) => n + (thread.status === "running" && !thread.subagent ? 1 : 0), 0))
  const [settled, setSettled] = useState(0)
  const lastRunning = useRef(running)
  useEffect(() => {
    if (running < lastRunning.current) setSettled((value) => value + 1)
    lastRunning.current = running
  }, [running])
  const loadedKey = useRef<string | null>(null)
  useEffect(() => {
    let canceled = false
    const silent = loadedKey.current === key
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    start.setUTCDate(start.getUTCDate() - Number(period === "all" ? 30 : period) + 1)
    const since = period === "all" ? undefined : start.toISOString()
    const load = async () => {
      const client = rpc()
      const summary = client.call("usage.summary", { group_by: group, since })
      const days = group === "day" ? summary : client.call("usage.summary", { group_by: "day", since })
      const [totals, daily] = await Promise.all([summary, days])
      return { key, scope, summary: totals, days: daily, end: now.toISOString().slice(0, 10) }
    }
    void load().then((next) => {
      if (!canceled) { loadedKey.current = key; setResult(next); setFailure(null) }
    }).catch((error) => { if (!canceled && !silent) setFailure({ key, message: errorText(error) }) })
    return () => { canceled = true }
  }, [key, scope, period, group, settled])
  const accountLimits = limitProviders.filter((entry) => entry.limits.length > 0)
  // Settings › Accounts links to one account's card. Scroll to it once it is on the page; a missing card is ignored.
  const anchor = useRef<string | null>(null)
  useEffect(() => { anchor.current = takeUsageAnchor() }, [])
  useEffect(() => {
    const id = anchor.current
    const node = id ? document.getElementById(id) : null
    if (!id || !node) return
    anchor.current = null
    node.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }, [limitProviders])
  const newest = accountLimits.reduce<string | undefined>((latest, entry) => (entry.updated_at && (!latest || entry.updated_at > latest) ? entry.updated_at : latest), undefined)
  // Never show the previous filter's totals under the next filter's label.
  const data = result?.scope === scope ? result : null
  const error = failure?.key === key ? failure.message : null
  const loading = result?.key !== key && !error
  const rows = data ? [...data.summary.rows].sort((a, b) => group === "day" ? b.key.localeCompare(a.key) : count(b) - count(a)) : []
  const max = Math.max(1, ...rows.map(count))
  const chart = data ? Array.from({ length: period === "7" ? 7 : 30 }, (_, index) => {
    const date = new Date(`${data.end}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - (period === "7" ? 6 : 29) + index)
    const key = date.toISOString().slice(0, 10)
    return { key, value: data.days.rows.find(row => row.key === key) }
  }) : []
  const chartMax = Math.max(1, ...chart.map(day => day.value ? count(day.value) : 0))
  return <div className="grid gap-7" data-usage-page>
    <div className="usage-toolbar">
      <Menu><MenuTrigger aria-label="Usage period" render={<Button variant="chrome-outline" size="sm" />}>{PERIODS[period]}<ChevronDownIcon className="size-3.5" /></MenuTrigger>
        <ComposerPickerMenuPopup align="start"><MenuGroup><MenuRadioGroup value={period} onValueChange={(next) => setPeriod(next as Period)}>{Object.entries(PERIODS).map(([value, label]) => <MenuRadioItem key={value} value={value}>{label}</MenuRadioItem>)}</MenuRadioGroup></MenuGroup></ComposerPickerMenuPopup>
      </Menu>
    <div className="usage-segments" role="group" aria-label="Group usage by">{([['provider', 'Agent'], ['model', 'Model'], ['day', 'Day']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value)}>{label}</button>)}</div>
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => { refresh(value => value + 1); refreshUsageLimits() }}><RefreshCwIcon className="size-3.5" />{loading && data ? "Refreshing…" : "Refresh"}</Button>
    </div>

    {accountLimits.length > 0 && <section aria-label="Account limits">
      <div className="usage-section-heading"><h2>Account limits</h2><span className="usage-filter-label" aria-live="polite">{limitsRefreshing ? "Updating…" : newest ? `Updated ${updatedAgo(newest, now)}` : null}</span></div>
      <div className="usage-limits">
        {accountLimits.map((entry) => {
          const kind = entry.provider
          const ago = limitsStale(entry, now) ? updatedAgo(entry.updated_at, now) : null
          const reason = staleReason(entry, now)
          return <div key={kind} className="usage-limit-card">
            <div className="usage-limit-provider">{PROVIDER_NAMES[kind] && <ProviderMark kind={kind} size={16} className="size-4 shrink-0" />}<span>{PROVIDER_NAMES[kind] ?? kind}</span>{entry.plan && <span className="ms-auto font-normal text-muted-foreground">{entry.plan}</span>}</div>
            {entry.limits.map((limit, index) => {
              const percent = limitUsed(limit, now)
              const name = limitLabel(limit, kind)
              const pace = limitPace(limit, now)
              return <div key={index} className="usage-limit" data-usage-tone={limitTone(percent)}>
                <div className="usage-limit-heading"><b>{name}</b><span>{limitLeftLabel(limit, now)}</span></div>
                {percent !== null && <LimitMeter left={100 - percent} pace={pace} label={`${name} left`} />}
                <p className="usage-limit-reset flex justify-between gap-3"><span>{resetIn(limit.resets_at, now)}</span>{pace && <span data-pace-short={pace.short || undefined}>{pace.label}</span>}</p>
              </div>
            })}
            {ago && <p className="usage-limit-reset">Last updated {ago}</p>}
            {reason && <p className="usage-limit-reset">{reason}</p>}
          </div>
        })}
      </div>
    </section>}

    {loading && !data && <div role="status" className="grid gap-4"><p className="settings-note">Loading usage…</p><div className="usage-skeleton" aria-hidden="true" /></div>}
    {error && <div role="alert" className="usage-state"><h2 className="font-medium">{data ? "Unable to refresh usage" : "Unable to load usage"}</h2><p>{error}{data && " Showing the last loaded totals."}</p><Button variant="chrome-outline" size="sm" onClick={() => refresh(value => value + 1)}>Try again</Button></div>}
    {data && <>
      <dl className="usage-summary">
        <div className="usage-stat"><dt>Reported cost</dt><dd>{usd(data.summary.total.cost_usd)}</dd><p>Pay-as-you-go equivalent, not your bill</p></div>
        <div className="usage-stat"><dt>Input + output tokens</dt><dd title={count(data.summary.total).toLocaleString()}>{tokens(count(data.summary.total))}</dd><p>{tokens(data.summary.total.usage.input_tokens)} input · {tokens(data.summary.total.usage.output_tokens)} output</p></div>
        <div className="usage-stat"><dt>Completed turns</dt><dd>{data.summary.total.turns.toLocaleString()}</dd><p>{tokens(data.summary.total.usage.cache_read_tokens)} cache read · {tokens(data.summary.total.usage.cache_write_tokens)} cache write</p></div>
      </dl>
      <PlanValue apiEquivalent={data.summary.total.cost_usd} period={period} />
      {data.summary.rows.length === 0 ? <div className="usage-state"><h2 className="font-medium">No usage in this period</h2><p>Usage appears here after an agent finishes a turn on this machine. Try a longer period to see earlier activity.</p>{period !== "all" && <Button size="sm" variant="chrome-outline" onClick={() => setPeriod("all")}>Show all time</Button>}</div> : <section aria-label="Daily token activity">
        <div className="usage-section-heading"><h2>Daily activity</h2><span className="usage-filter-label">{activeDay ?? <>{period === "7" ? "Last 7 days" : "Last 30 days"} · UTC</>}</span></div>
        <div className="usage-chart">{chart.map(day => {
          const n = day.value ? count(day.value) : 0
          const label = `${dayLabel(day.key)}: ${n.toLocaleString()} input and output tokens`
          return <div key={day.key} className="usage-chart-day" tabIndex={0} role="img" aria-label={label} title={label} onMouseEnter={() => setActiveDay(`${dayLabel(day.key)} · ${tokens(n)} tokens`)} onMouseLeave={() => setActiveDay(null)} onFocus={() => setActiveDay(`${dayLabel(day.key)} · ${tokens(n)} tokens`)} onBlur={() => setActiveDay(null)}><span className="usage-chart-bar" style={{ height: `${Math.max(n ? 3 : 0, n / chartMax * 100)}%`, opacity: n ? undefined : .12 }} /></div>
        })}</div>
        <div className="usage-chart-labels" aria-hidden="true"><span>{dayLabel(chart[0].key)}</span><span>{dayLabel(chart[Math.floor(chart.length / 2)].key)}</span><span>{dayLabel(chart[chart.length - 1].key)}</span></div>
      </section>}
      <section aria-label="Usage breakdown">
        <div className="usage-section-heading"><h2>Breakdown</h2></div>
        {rows.length > 0 && <table className="usage-table"><thead><tr><th scope="col">{group === "provider" ? "Agent" : group === "model" ? "Model" : "Day (UTC)"}</th><th scope="col" className="usage-turns">Turns</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead><tbody>{rows.slice(0, rowLimit).map(row => <tr key={row.key}><td><div className="usage-row-name">{group === "provider" && PROVIDER_NAMES[row.key] && <ProviderMark kind={row.key as ProviderKind} size={14} className="size-3.5 shrink-0" />}<span>{group === "provider" ? PROVIDER_NAMES[row.key] ?? row.key : group === "day" ? dayLabel(row.key, true) : row.key === "(default)" ? "Default model" : row.key}</span></div><div className="usage-row-meter" aria-hidden="true"><span style={{ width: `${count(row) / max * 100}%` }} /></div></td><td className="usage-turns">{row.turns.toLocaleString()}</td><td title={count(row).toLocaleString()}>{tokens(count(row))}</td><td>{usd(row.cost_usd)}</td></tr>)}</tbody></table>}
        {rows.length > rowLimit && <Button variant="ghost" size="sm" onClick={() => setRowLimit(value => value + 20)}>Show more</Button>}
      </section>
      <p className="settings-note">Turns recorded by this Kybern daemon. Cost is each agent's own figure — on a subscription (Claude, Codex) it's the pay-as-you-go equivalent, not your actual bill, and some agents report none. Cache tokens count toward cost but are listed separately.</p>
    </>}
  </div>
}

const PLAN_COST_KEY = "kybern.usage.plan-cost"

/** Reframes the pay-as-you-go cost as subscription value: how much compute your
 *  flat fee actually bought. Plan cost is stored locally — no account needed. */
function PlanValue({ apiEquivalent, period }: { apiEquivalent: number; period: Period }) {
  const [monthly, setMonthly] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(PLAN_COST_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const commit = () => {
    const value = Number(draft)
    if (Number.isFinite(value) && value > 0) {
      setMonthly(value)
      localStorage.setItem(PLAN_COST_KEY, String(value))
    } else {
      setMonthly(null)
      localStorage.removeItem(PLAN_COST_KEY)
    }
    setEditing(false)
  }
  const startEdit = () => { setDraft(monthly ? String(monthly) : ""); setEditing(true) }
  const days = period === "7" ? 7 : period === "30" ? 30 : null
  const planForPeriod = monthly != null && days != null ? (monthly * days) / 30 : null
  const multiple = planForPeriod && planForPeriod > 0 ? apiEquivalent / planForPeriod : null
  const periodLabel = period === "7" ? "in the last 7 days" : period === "30" ? "this month" : "so far"
  return (
    <div className="usage-plan-value">
      <div className="usage-plan-head">
        <span className="usage-plan-title">Subscription value</span>
        {editing ? (
          <span className="usage-plan-edit">
            <InputGroup className="w-24">
              <InputGroupAddon>$</InputGroupAddon>
              <InputGroupInput aria-label="Total plan cost per month" inputMode="decimal" placeholder="200" autoFocus value={draft}
                onChange={(event) => setDraft(event.target.value.replace(/[^0-9.]/g, ""))}
                onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setEditing(false) }} />
            </InputGroup>
            <Button size="xs" variant="chrome-outline" onClick={commit}>Save</Button>
          </span>
        ) : (
          <Button size="xs" variant="ghost" onClick={startEdit}>{monthly != null ? `$${monthly}/mo` : "Set plan cost"}</Button>
        )}
      </div>
      {multiple != null ? <>
        <div className="usage-plan-multiple">{multiple >= 10 ? Math.round(multiple).toLocaleString() : multiple.toFixed(1)}&times;</div>
        <p className="usage-plan-caption">You ran <b className="text-foreground">{usd(apiEquivalent)}</b> of pay-as-you-go compute on {usd(planForPeriod!)} of subscription {periodLabel}.</p>
      </> : monthly != null ? (
        <p className="usage-plan-caption"><b className="text-foreground">{usd(apiEquivalent)}</b> of pay-as-you-go compute on your subscription {periodLabel}. Pick a 7- or 30-day period to see your value multiple.</p>
      ) : (
        <p className="usage-plan-caption">Add your total plan cost per month to see how much pay-as-you-go compute your flat fee actually covers.</p>
      )}
    </div>
  )
}

/** Usage as a top-level page, opened from the app rail. */
export function UsageView() {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
      <SurfaceHeader>
        <h1 className="truncate font-system-ui text-sm font-medium">Usage</h1>
      </SurfaceHeader>
      <main className="settings-scroll">
        <div className="settings-page settings-page-wide">
          <UsagePage />
        </div>
      </main>
    </div>
  )
}
