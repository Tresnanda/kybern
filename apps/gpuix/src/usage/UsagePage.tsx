import { motion } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { tokens, usd } from '@/lib/format'
import { PROVIDER_NAMES, limitLabel, limitLeftLabel, limitPace, limitUsed, limitTone, resetIn, staleCaption, updatedAgo } from '@/lib/providerUsage'
import { accountsOfKind, limitsForAccount } from '@/lib/accountUi'
import type { AccountSummary, UsageLimitsResult, UsageGroup, UsageRow, UsageSummaryResult, ProviderLimits } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { askLimits } from '../nav/live.ts'
import { getNav, useNav } from '../nav/store.ts'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { EASE_OUT, ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { load, save as savePreference } from '../pulls/persist.ts'
import { Button, Header, Segments, column, row } from './controls.tsx'

const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']] as const
type Period = typeof PERIODS[number][0]
const count = (r: UsageRow) => r.usage.input_tokens + r.usage.output_tokens
const dayLabel = (key: string, year = false) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}) })
type Loaded = { scope: string; revision: number; summary: UsageSummaryResult; daily: UsageSummaryResult; end: string }

export function UsagePage() {
  const t = useTheme()
  const connection = useApp(s => s.status)
  const running = useApp(s => s.threads.filter(t => t.status === 'running').length)
  const limits = useNav(s => s.limits)
  const refreshing = useNav(s => s.limitsRefreshing.length > 0)
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [accountLimits, setAccountLimits] = useState<ProviderLimits[]>([])
  const [accountRevision, refreshAccounts] = useState(0)
  useEffect(() => {
    const client = getClient()
    if (connection !== 'open' || !client) return
    let canceled = false
    const unsubscribe = client.onNotification('usage.limits.changed', event => { if (!canceled) setAccountLimits((event as UsageLimitsResult).accounts ?? []) })
    void client.call('providers.accounts.list', {}).then(r => { if (!canceled) setAccounts(r.accounts) }, () => {})
    void client.call('usage.limits', { cached: true, all_accounts: true, ...(accountRevision > 0 ? { refresh: true } : {}) }).then(r => { if (!canceled) setAccountLimits(r.accounts ?? []) }, () => {})
    return () => { canceled = true; unsubscribe() }
  }, [connection, accountRevision])
  const groups = [...new Set([...limits.map(l => l.provider), ...accountLimits.map(l => l.provider)])].flatMap(kind => {
    const own = accountsOfKind(accounts, kind)
    const cards: { entry: ProviderLimits | undefined; account: AccountSummary | undefined }[] = own.length < 2 ? [{ entry: limits.find(l => l.provider === kind), account: own[0] }] : own.map(account => ({ entry: limitsForAccount(account, accountLimits, limits), account }))
    const found = cards.filter((c): c is { entry: ProviderLimits; account: AccountSummary | undefined } => !!c.entry?.limits.length)
    return found.length ? [{ kind, cards: found }] : []
  })
  const newest = [...limits, ...accountLimits].reduce<string | undefined>((last, entry) => entry.updated_at && (!last || entry.updated_at > last) ? entry.updated_at : last, undefined)
  const [period, setPeriod] = useState<Period>('30')
  const [group, setGroup] = useState<UsageGroup>('provider')
  const [revision, refresh] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ scope: string; text: string } | null>(null)
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [entryPlayed, setEntryPlayed] = useState(false)
  const [entryMotion] = useState(() => !getNav().keyboardNav)
  const previousRunning = useRef(running)
  useEffect(() => { if (running < previousRunning.current) refresh(n => n + 1); previousRunning.current = running }, [running])
  const scope = `${connection}:${period}:${group}`
  useEffect(() => {
    if (connection !== 'open') return
    let canceled = false
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    start.setUTCDate(start.getUTCDate() - Number(period === 'all' ? 30 : period) + 1)
    const since = period === 'all' ? undefined : start.toISOString()
    const client = getClient()!
    const summary = client.call('usage.summary', { group_by: group, since })
    const daily = group === 'day' ? summary : client.call('usage.summary', { group_by: 'day', since })
    void Promise.all([summary, daily]).then(([summary, daily]) => {
      if (!canceled) { setLoaded({ scope, revision, summary, daily, end: now.toISOString().slice(0, 10) }); setFailure(null) }
    }, e => { if (!canceled) setFailure({ scope, text: String(e) }) })
    return () => { canceled = true }
  }, [scope, period, group, revision, connection])
  const data = loaded?.scope === scope ? loaded : null
  const error = failure?.scope === scope ? failure.text : null
  const loading = (!data || data.revision !== revision) && !error
  const rows = data ? [...data.summary.rows].sort((a, b) => group === 'day' ? b.key.localeCompare(a.key) : count(b) - count(a)) : []
  const max = Math.max(1, ...rows.map(count))
  const chart = data ? Array.from({ length: period === '7' ? 7 : 30 }, (_, i) => {
    const date = new Date(`${data.end}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - (period === '7' ? 6 : 29) + i)
    const key = date.toISOString().slice(0, 10)
    const found = data.daily.rows.find(r => r.key === key)
    return { key, n: found ? count(found) : 0 }
  }) : []
  const chartMax = Math.max(1, ...chart.map(d => d.n))
  // Entry only: once the first set of bars has painted, neither virtual remounts
  // nor period/group switches can replay the grow animation.
  useEffect(() => {
    if (!data || entryPlayed) return
    const timer = setTimeout(() => setEntryPlayed(true), 260)
    return () => clearTimeout(timer)
  }, [data, entryPlayed])
  const changePeriod = (p: Period) => { setEntryPlayed(true); setPeriod(p); setActiveDay(null) }
  const changeGroup = (g: UsageGroup) => { setEntryPlayed(true); setGroup(g) }
  const refreshAll = () => { refresh(n => n + 1); refreshAccounts(n => n + 1); askLimits(true) }
  const sections: { key: string; content: ReactNode }[] = [
    { key: 'toolbar', content: <div style={{ ...row, justifyContent: 'space-between', gap: 16 }}>
      <Menu testId="usage-period" trigger={() => <Button style={{ borderWidth: 1, borderColor: t.border }}>{`${PERIODS.find(p => p[0] === period)![1]}⌄`}</Button>}>
        {PERIODS.map(([value, label]) => <MenuItem key={value} id={value} label={label} checked={period === value} testId={`usage-period-${value}`} onSelect={() => changePeriod(value)} />)}
      </Menu>
      <Segments value={group} options={ [['provider', 'Agent'], ['model', 'Model'], ['day', 'Day']] } onChange={changeGroup} testId="usage-group" width={62} />
      <Button testId="usage-refresh" disabled={loading} onClick={refreshAll}>{loading && data ? 'Refreshing…' : 'Refresh'}</Button>
    </div> },
  ]
  if (groups.length) {
    sections.push({ key: 'limits-heading', content: <Heading title="Account limits" detail={refreshing ? 'Updating…' : newest ? `Updated ${updatedAgo(newest, Date.now())}` : undefined} /> })
    for (const group of groups) sections.push({ key: `limits-${group.kind}`, content: <div style={{ ...column, gap: 10 }}><div style={row}><ProviderMark kind={group.kind} size={14} /><Label color={t.textSecondary} size={12} weight={500}>{PROVIDER_NAMES[group.kind] ?? group.kind}</Label></div><div style={{ ...row, width: '100%', alignItems: 'stretch', flexWrap: 'wrap', gap: 14 }}>{group.cards.map(({ entry, account }) => <LimitCard key={account?.provider.instance ?? 'default'} entry={entry} account={account} showDefault={group.cards.length > 1} />)}</div></div> })
  }
  if (loading && !data) sections.push({ key: 'loading', content: <div role="status" style={{ ...column, gap: 16 }}><Label color={t.textSecondary} size={12}>Loading usage…</Label><div style={{ height: 150, borderRadius: 10, backgroundColor: t.buttonSecondary }} /></div> })
  if (error) sections.push({ key: 'error', content: <div role="alert" style={{ ...column, gap: 10 }}><Label color={t.text}>{data ? 'Unable to refresh usage' : 'Unable to load usage'}</Label><Label color={t.textSecondary}>{`${error}${data ? ' Showing the last loaded totals.' : ''}`}</Label><Button onClick={refreshAll}>Try again</Button></div> })
  if (data) {
    const total = data.summary.total
    sections.push({ key: 'stats', content: <div testId="usage-stats" style={{ ...row, width: '100%', alignItems: 'flex-start', gap: 24, paddingTop: 8, paddingBottom: 26, borderBottomWidth: 1, borderColor: t.border }}>
      <Stat label="Reported cost" value={usd(total.cost_usd)} note="Pay-as-you-go equivalent, not your bill" />
      <Stat label="Input + output tokens" value={tokens(count(total))} note={`${tokens(total.usage.input_tokens)} input · ${tokens(total.usage.output_tokens)} output`} />
      <Stat label="Completed turns" value={total.turns.toLocaleString()} note={`${tokens(total.usage.cache_read_tokens)} cache read · ${tokens(total.usage.cache_write_tokens)} cache write`} />
    </div> })
    sections.push({ key: 'plan', content: <PlanValue cost={total.cost_usd} period={period} /> })
    sections.push({ key: 'chart', content: rows.length ? <div style={{ ...column, gap: 10 }}>
      <Heading title="Daily activity" detail={activeDay ?? `${period === '7' ? 'Last 7 days' : 'Last 30 days'} · UTC`} />
      <div testId="usage-chart" style={{ ...row, alignItems: 'flex-end', gap: 5, height: 126, paddingTop: 8, borderBottomWidth: 1, borderColor: t.border }}>
        {chart.map((d, i) => {
          const height = Math.max(2, d.n / chartMax * 118)
          const play = entryMotion && !entryPlayed
          return <div key={d.key} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }}><Tip label={`${dayLabel(d.key)}: ${d.n.toLocaleString()} input and output tokens`}><div tabIndex={0} testId={`usage-bar-${i}`} onMouseEnter={() => setActiveDay(`${dayLabel(d.key)} · ${tokens(d.n)} tokens`)} onMouseLeave={() => setActiveDay(null)} style={{ ...column, justifyContent: 'flex-end', height: 118, width: '100%' }}>
            <motion.div initial={play ? { height: REDUCED_MOTION ? height : 2, opacity: 0 } : false} animate={{ height, opacity: d.n ? .65 : .12 }} transition={{ duration: play ? .15 : 0, delay: play ? Math.min(i, 4) * .025 : 0, ease: EASE_OUT }} style={{ width: '100%', borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: t.text, hover: { opacity: 1 } }} />
          </div></Tip></div>
        })}
      </div>
      <div style={{ ...row, justifyContent: 'space-between' }}>{[chart[0], chart[Math.floor(chart.length / 2)], chart[chart.length - 1]].map(d => <Label key={d!.key} color={t.textSecondary} size={11}>{dayLabel(d!.key)}</Label>)}</div>
    </div> : <div style={{ ...column, gap: 10 }}><Label color={t.text}>No usage in this period</Label><Label color={t.textSecondary} size={13}>Usage appears here after an agent finishes a turn on this machine. Try a longer period to see earlier activity.</Label>{period !== 'all' && <Button onClick={() => changePeriod('all')}>Show all time</Button>}</div> })
    sections.push({ key: 'breakdown', content: <div style={{ ...column, gap: 20 }}><Heading title="Breakdown" /><div style={{ ...row, width: '100%', gap: 0 }}>{[group === 'provider' ? 'Agent' : group === 'model' ? 'Model' : 'Day (UTC)', 'Turns', 'Tokens', 'Cost'].map((s, i) => <Label key={s} color={t.textSecondary} size={11} style={{ width: i === 0 ? '50%' : '16.666%', textAlign: i ? 'right' : 'left' }}>{s}</Label>)}</div></div> })
    for (const r of rows) sections.push({ key: `row-${r.key}`, content: <div style={{ ...row, width: '100%', gap: 0, paddingTop: 16, paddingBottom: 16, borderTopWidth: 1, borderColor: t.border }}>
      <div style={{ ...column, width: '50%', gap: 10 }}><div style={row}>{group === 'provider' && <ProviderMark kind={r.key} size={14} />}<Label color={t.text} size={13} truncate>{group === 'provider' ? PROVIDER_NAMES[r.key] ?? r.key : group === 'day' ? dayLabel(r.key, true) : r.key === '(default)' ? 'Default model' : r.key}</Label></div><div style={{ height: 3, maxWidth: 240, backgroundColor: t.buttonSecondary, borderRadius: 2 }}><div style={{ width: `${count(r) / max * 100}%`, height: 3, backgroundColor: ink(t, .5), borderRadius: 2 }} /></div></div>
      {[r.turns.toLocaleString(), tokens(count(r)), usd(r.cost_usd)].map((v, i) => <Label key={i} color={t.text} size={13} style={{ width: '16.666%', textAlign: 'right' }}>{v}</Label>)}
    </div> })
    sections.push({ key: 'note', content: <Label color={t.textSecondary} size={12} lineHeight={19}>Turns recorded by this Kybern daemon. Cost is each agent's own figure — on a subscription (Claude, Codex) it's the pay-as-you-go equivalent, not your actual bill, and some agents report none. Cache tokens count toward cost but are listed separately.</Label> })
  }
  return <div testId="page-usage" style={{ ...column, flexGrow: 1, minHeight: 0 }}><Header title="Usage" /><virtual-list testId="usage-scroll" style={{ flexGrow: 1, minHeight: 0 }} estimatedItemHeight={140}>{sections.map(({ key, content }) => <div key={key} style={{ ...row, width: '100%', justifyContent: 'center', paddingLeft: 40, paddingRight: 40, paddingTop: key === 'toolbar' ? 26 : key.startsWith('row-') ? 0 : 28, paddingBottom: key === 'note' ? 64 : 0 }}><div style={{ ...column, flexGrow: 1, flexBasis: 0, width: '100%', maxWidth: 960 }}>{content}</div></div>)}</virtual-list></div>
}

function Heading({ title, detail }: { title: string; detail?: string }) { const t = useTheme(); return <div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.text} size={14} weight={600}>{title}</Label>{detail && <Label color={t.textSecondary} size={12}>{detail}</Label>}</div> }
function Stat({ label, value, note }: { label: string; value: string; note: string }) { const t = useTheme(); return <div style={{ ...column, flexBasis: 0, flexGrow: 1, gap: 8 }}><Label color={t.textSecondary} size={12}>{label}</Label><Label color={t.text} size={34} weight={500}>{value}</Label><Label color={t.textSecondary} size={12} lineHeight={18}>{note}</Label></div> }
function LimitCard({ entry, account, showDefault }: { entry: ProviderLimits; account?: AccountSummary; showDefault: boolean }) {
  const t = useTheme(); const now = Date.now()
  return <div style={{ ...column, flexBasis: 248, flexGrow: 1, gap: 16, padding: 16, borderWidth: 1, borderColor: t.border, borderRadius: 12 }}><div style={row}><ProviderMark kind={entry.provider} size={20} /><Label color={t.text} size={13} weight={500} style={{ flexGrow: 1 }}>{account?.name ?? 'CLI account'}</Label>{showDefault && account?.is_default && <Label color={t.textSecondary} size={11}>Default</Label>}<Label color={t.textSecondary} size={12}>{entry.plan ?? account?.identity?.plan ?? ''}</Label></div>{entry.limits.map((limit, i) => {
    const used = limitUsed(limit, now); const pace = limitPace(limit, now)
    return <div key={i} style={{ ...column, gap: 7 }}><div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.text} size={12}>{limitLabel(limit, entry.provider)}</Label><Label color={t.textSecondary} size={12}>{limitLeftLabel(limit, now)}</Label></div>{used !== null && <div style={{ position: 'relative', height: 4, backgroundColor: ink(t, .1), borderRadius: 2 }}><div style={{ width: `${Math.max(0, 100 - used)}%`, height: 4, backgroundColor: limitTone(used) === 'critical' ? t.red : limitTone(used) === 'warning' ? t.warning : ink(t, .65), borderRadius: 2 }} />{pace && <div style={{ position: 'absolute', left: 0, top: -3, height: 10, width: `${pace.evenLeft}%`, borderRightWidth: 1, borderColor: ink(t, .45) }} />}</div>}<div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.textSecondary} size={11}>{resetIn(limit.resets_at, now)}</Label>{pace && <Label color={pace.short ? t.warning : t.textSecondary} size={11}>{pace.label}</Label>}</div></div>
  })}{staleCaption(entry, now) && <Label color={t.textSecondary} size={11}>{staleCaption(entry, now)}</Label>}</div>
}

const storedPlan = Number(load('usage.plan-cost', null))
let planCost: number | null = Number.isFinite(storedPlan) && storedPlan > 0 ? storedPlan : null
function PlanValue({ cost, period }: { cost: number; period: Period }) {
  const t = useTheme(); const [error, setError] = useState<string | null>(null); const [monthly, setMonthly] = useState(planCost); const [edit, setEdit] = useState(false); const [draft, setDraft] = useState('')
  const periodCost = monthly && period !== 'all' ? monthly * Number(period) / 30 : null
  const multiple = periodCost ? cost / periodCost : null
  const periodLabel = period === '7' ? 'in the last 7 days' : period === '30' ? 'this month' : 'so far'
  const save = () => { const n = Number(draft); const next = Number.isFinite(n) && n > 0 ? n : null; try { savePreference('usage.plan-cost', next); planCost = next; setMonthly(next); setEdit(false); setError(null) } catch { setError('Unable to save plan cost. Check your local preferences folder and try again.') } }
  return <div style={{ ...column, gap: 8, padding: 18, borderWidth: 1, borderColor: t.border, borderRadius: 12 }}><div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.text} size={13} weight={600}>Subscription value</Label>{edit ? <div style={row}><input testId="usage-plan-input" autoFocus value={draft} onChange={e => setDraft((e.value ?? '').replace(/[^0-9.]/g, ''))} onSubmit={save} onKeyDown={e => { if (e.key === 'escape') setEdit(false) }} placeholder="200" style={{ width: 96, height: 28, color: t.text, backgroundColor: t.buttonSecondary }} /><Button onClick={save}>Save</Button></div> : <Button testId="usage-plan-edit" onClick={() => { setDraft(monthly ? String(monthly) : ''); setEdit(true) }}>{monthly ? `$${monthly}/mo` : 'Set plan cost'}</Button>}</div>{error && <Label color={t.red} size={12}>{error}</Label>}{multiple !== null && <Label color={t.text} size={42} weight={600}>{`${multiple >= 10 ? Math.round(multiple).toLocaleString() : multiple.toFixed(1)}×`}</Label>}<Label color={t.textSecondary} size={12} lineHeight={19}>{multiple !== null ? `You ran ${usd(cost)} of pay-as-you-go compute on ${usd(periodCost!)} of subscription ${periodLabel}.` : monthly ? `${usd(cost)} of pay-as-you-go compute on your subscription ${periodLabel}. Pick a 7- or 30-day period to see your value multiple.` : 'Add your total plan cost per month to see how much pay-as-you-go compute your flat fee actually covers.'}</Label></div>
}
