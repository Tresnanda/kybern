import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ProviderMark } from "@/components/kybern/bits"
import { ChevronDownIcon, RefreshCwIcon } from "@/lib/kit/icons"
import { tokens, usd } from "@/lib/format"
import { limitLabel, reportedPercent, resetLabel } from "@/lib/providerUsage"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import type { ProviderKind, ProviderLimits, ProviderUsage, UsageGroup, UsageSummaryResult } from "@/protocol"

type ReportedLimit = NonNullable<ProviderUsage["limits"]>[number]

function limitTone(percent: number | null): "normal" | "warning" | "critical" {
  if (percent === null) return "normal"
  if (percent >= 95) return "critical"
  if (percent >= 80) return "warning"
  return "normal"
}

type Period = "7" | "30" | "all"
const PERIODS: Record<Period, string> = { "7": "Last 7 days", "30": "Last 30 days", all: "All time" }
const PROVIDERS: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", pi: "pi", omp: "Oh My Pi" }
const dayLabel = (key: string, includeYear = false) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC", ...(includeYear ? { year: "numeric" } as const : {}) })
const count = (row: UsageSummaryResult["total"]) => row.usage.input_tokens + row.usage.output_tokens

export function UsagePage() {
  const environmentId = useStore((s) => s.environmentId)
  const connection = useStore((s) => s.connection.state)
  const threads = useStore((s) => s.threads)
  const transcripts = useStore((s) => s.transcripts)
  // Plan limits arrive live per thread (5-hour / weekly). Show the freshest known
  // window per provider — latest reset time wins, then higher reported usage.
  const providerLimits = useMemo(() => {
    const byProvider = new Map<ProviderKind, Map<string, ReportedLimit>>()
    for (const [id, transcript] of Object.entries(transcripts)) {
      const limits = transcript?.providerUsage?.limits
      const kind = threads[id]?.provider?.kind
      if (!limits?.length || !kind) continue
      const windows = byProvider.get(kind) ?? new Map<string, ReportedLimit>()
      for (const limit of limits) {
        const windowKey = String(limit.window_minutes ?? limit.name)
        const prev = windows.get(windowKey)
        const fresher = !prev
          || (limit.resets_at ?? 0) > (prev.resets_at ?? 0)
          || ((limit.resets_at ?? 0) === (prev.resets_at ?? 0) && limit.used_percent > prev.used_percent)
        if (fresher) windows.set(windowKey, limit)
      }
      byProvider.set(kind, windows)
    }
    return [...byProvider.entries()].map(([kind, windows]) => ({
      kind,
      limits: [...windows.values()].sort((a, b) => (a.window_minutes ?? Number.MAX_SAFE_INTEGER) - (b.window_minutes ?? Number.MAX_SAFE_INTEGER)),
    }))
  }, [threads, transcripts])
  // Authoritative limits from the daemon's store — available without opening a
  // thread or prompting first. Falls back to the live per-thread values while it
  // loads (or if an older daemon lacks the method).
  const [storedLimits, setStoredLimits] = useState<ProviderLimits[] | null>(null)
  const [period, setPeriod] = useState<Period>("30")
  const [group, setGroup] = useState<UsageGroup>("provider")
  const [revision, refresh] = useState(0)
  const [rowLimit, setRowLimit] = useState(20)
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [result, setResult] = useState<{ key: string; scope: string; summary: UsageSummaryResult; days: UsageSummaryResult; end: string } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const scope = `${environmentId}:${connection}:${period}:${group}`
  const key = `${scope}:${revision}`
  useEffect(() => {
    let canceled = false
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
      if (!canceled) { setResult(next); setFailure(null) }
    }).catch((error) => { if (!canceled) setFailure({ key, message: errorText(error) }) })
    return () => { canceled = true }
  }, [key, scope, period, group])
  useEffect(() => {
    if (connection !== "open") return
    let canceled = false
    rpc().call("usage.limits", {}).then((result) => {
      if (!canceled) setStoredLimits(result.providers)
    }).catch(() => { /* older daemon lacks the method: keep the per-thread fallback */ })
    return () => { canceled = true }
  }, [environmentId, connection, revision])
  // Merge the daemon's stored snapshot with the live per-thread values so an
  // active thread's fresh limits win immediately (freshest window: later reset
  // time, then higher reported usage).
  const accountLimits = useMemo(() => {
    const byProvider = new Map<ProviderKind, Map<string, ReportedLimit>>()
    const sources = [providerLimits, (storedLimits ?? []).map((entry) => ({ kind: entry.provider, limits: entry.limits }))]
    for (const list of sources) for (const { kind, limits } of list) {
      const windows = byProvider.get(kind) ?? new Map<string, ReportedLimit>()
      for (const limit of limits) {
        const windowKey = String(limit.window_minutes ?? limit.name)
        const prev = windows.get(windowKey)
        const fresher = !prev
          || (limit.resets_at ?? 0) > (prev.resets_at ?? 0)
          || ((limit.resets_at ?? 0) === (prev.resets_at ?? 0) && limit.used_percent >= prev.used_percent)
        if (fresher) windows.set(windowKey, limit)
      }
      byProvider.set(kind, windows)
    }
    return [...byProvider.entries()]
      .map(([kind, windows]) => ({ kind, limits: [...windows.values()].sort((a, b) => (a.window_minutes ?? Number.MAX_SAFE_INTEGER) - (b.window_minutes ?? Number.MAX_SAFE_INTEGER)) }))
      .filter((entry) => entry.limits.length > 0)
  }, [providerLimits, storedLimits])
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
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => refresh(value => value + 1)}><RefreshCwIcon className="size-3.5" />{loading && data ? "Refreshing…" : "Refresh"}</Button>
    </div>

    {accountLimits.length > 0 && <section aria-label="Account limits">
      <div className="usage-section-heading"><h2>Account limits</h2><span className="usage-filter-label">Last reported by your agents</span></div>
      <div className="usage-limits">
        {accountLimits.map(({ kind, limits }) => <div key={kind} className="usage-limit-card">
          <div className="usage-limit-provider">{PROVIDERS[kind] && <ProviderMark kind={kind} size={16} className="size-4 shrink-0" />}<span>{PROVIDERS[kind] ?? kind}</span></div>
          {limits.map((limit, index) => {
            const percent = reportedPercent(limit.used_percent)
            return <div key={index} className="usage-limit" data-usage-tone={limitTone(percent)}>
              <div className="usage-limit-heading"><b>{limitLabel(limit)}</b><span>{percent === null ? "Unavailable" : `${Math.round(percent)}% used`}</span></div>
              <div className="usage-limit-meter"><span style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} /></div>
              <p className="usage-limit-reset">{resetLabel(limit.resets_at)}</p>
            </div>
          })}
        </div>)}
      </div>
    </section>}

    {loading && !data && <div role="status" className="grid gap-4"><p className="settings-note">Loading usage…</p><div className="usage-skeleton" aria-hidden="true" /></div>}
    {error && <div role="alert" className="usage-state"><h2 className="font-medium">{data ? "Unable to refresh usage" : "Unable to load usage"}</h2><p>{error}{data && " Showing the last loaded totals."}</p><Button variant="chrome-outline" size="sm" onClick={() => refresh(value => value + 1)}>Try again</Button></div>}
    {data && <>
      <dl className="usage-summary">
        <div className="usage-stat"><dt>Reported cost</dt><dd>{usd(data.summary.total.cost_usd)}</dd><p>From completed turns</p></div>
        <div className="usage-stat"><dt>Input + output tokens</dt><dd title={count(data.summary.total).toLocaleString()}>{tokens(count(data.summary.total))}</dd><p>{tokens(data.summary.total.usage.input_tokens)} input · {tokens(data.summary.total.usage.output_tokens)} output</p></div>
        <div className="usage-stat"><dt>Completed turns</dt><dd>{data.summary.total.turns.toLocaleString()}</dd><p>{tokens(data.summary.total.usage.cache_read_tokens)} cache read · {tokens(data.summary.total.usage.cache_write_tokens)} cache write</p></div>
      </dl>
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
        {rows.length > 0 && <table className="usage-table"><thead><tr><th scope="col">{group === "provider" ? "Agent" : group === "model" ? "Model" : "Day (UTC)"}</th><th scope="col" className="usage-turns">Turns</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead><tbody>{rows.slice(0, rowLimit).map(row => <tr key={row.key}><td><div className="usage-row-name">{group === "provider" && PROVIDERS[row.key] && <ProviderMark kind={row.key as ProviderKind} size={14} className="size-3.5 shrink-0" />}<span>{group === "provider" ? PROVIDERS[row.key] ?? row.key : group === "day" ? dayLabel(row.key, true) : row.key === "(default)" ? "Default model" : row.key}</span></div><div className="usage-row-meter" aria-hidden="true"><span style={{ width: `${count(row) / max * 100}%` }} /></div></td><td className="usage-turns">{row.turns.toLocaleString()}</td><td title={count(row).toLocaleString()}>{tokens(count(row))}</td><td>{usd(row.cost_usd)}</td></tr>)}</tbody></table>}
        {rows.length > rowLimit && <Button variant="ghost" size="sm" onClick={() => setRowLimit(value => value + 20)}>Show more</Button>}
      </section>
      <p className="settings-note">Includes completed turns recorded by this Kybern daemon. Costs are reported by agents; unreported costs and subscription charges are not included. Cache tokens are shown separately.</p>
    </>}
  </div>
}
