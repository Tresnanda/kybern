// Settings › Plugins: explicit copies of declarations; never package files or credentials.
import { useMemo, useState } from 'react'
import type { PluginsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import { contentsText, enabledText, pluginRows, providerName, jobText, type PluginFilter, type PluginRow } from '../../../../packages/kybern-client/src/pluginSync.ts'
import { Button } from '../kit/Button.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { StatusChip } from '../kit/StatusChip.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { ErrorText, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Row, Section } from '../settings/controls.tsx'
import { CopyPluginSheet } from './CopyPluginSheet.tsx'
import { refreshPlugins, usePluginsView } from './store.ts'

export function Plugins({ inlineSheet = false }: { inlineSheet?: boolean }) {
  const t = useTheme()
  const { view, error, loading } = usePluginsView()
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<PluginFilter>('all'), [limit, setLimit] = useState(50)
  // Freeze the entire review. Refreshes cannot silently change what Confirm authorizes.
  const [review, setReview] = useState<{ view: PluginsNetworkView; rows: PluginRow[]; target?: string } | null>(null)
  const all = useMemo(() => view ? pluginRows(view) : [], [view])
  const rows = useMemo(() => view ? pluginRows(view, query, filter) : [], [view, query, filter])
  if (!view) return <Section title="Plugins"><Row title="" description={error ? <ErrorText>{error}</ErrorText> : <Hint>{loading ? 'Reading plugins on your machines…' : 'Connect to a machine to see its plugins.'}</Hint>} /></Section>
  const jobs = view.machines.flatMap(m => m.inventory?.jobs ?? []).slice(0, 12)
  return <>
    <Section title="Machines" accessory={<Button testId="plugins-refresh" size="sm" variant="ghost" onClick={() => void refreshPlugins()}>Refresh</Button>}>
      {view.machines.map(machine => {
        const missing = all.filter(r => !r.different && r.cells.some(c => c.machine.id === machine.id && c.state === 'missing') && r.cells.some(c => c.state === 'same' && !c.plugin?.problem))
        return <div key={machine.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16 }}>
          <MachineBadge glyph={glyphOfMachine(machine.id)} size={20} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexGrow: 1, minWidth: 0 }}>
            <Label color={t.text} size={14} weight={500}>{machine.name + (machine.is_self ? ' (this computer)' : '')}</Label>
            <Label color={t.textSecondary} size={13}>{machine.state === 'reported' ? `${machine.inventory?.plugins.length ?? 0} plugins and sources · ${missing.length} missing` : machine.detail ?? (machine.state === 'offline' ? 'Offline · copies wait for it' : 'Update Kybern or check Files access')}</Label>
          </div>
          {missing.length > 0 && <Button testId={`plugins-missing-${machine.id}`} size="sm" variant="secondary" onClick={() => setReview({view, rows: missing, target: machine.id})}>{`Copy ${missing.length} missing…`}</Button>}
        </div>
      })}
    </Section>
    <Section title="Plugins and sources" accessory={<Segmented testId="plugins-filter" size="sm" aria-label="Show plugins" value={filter} onChange={v => {setFilter(v as PluginFilter);setLimit(50)}} options={[
      {value: 'all', label: 'All', count: all.length}, {value: 'different', label: 'Different', count: all.filter(r => r.different).length}, {value: 'missing', label: 'Missing', count: all.filter(r => r.missing).length},
    ]} />}>
      <div style={{display: 'flex', padding: 12}}><SearchField testId="plugins-search" label="Search plugins" placeholder="Search plugins or agents" value={query} onChange={v => {setQuery(v);setLimit(50)}} width="100%" /></div>
      {rows.slice(0, limit).map(row => <div key={row.key} testId={`plugin-${row.key}`} style={{display: 'flex', alignItems: 'center', gap: 12, padding: 16}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 5, flexGrow: 1, flexShrink: 1, minWidth: 0}}>
          <Label color={t.text} size={14} weight={500}>{row.plugin.name}</Label>
          <Label color={t.textSecondary} size={13}>{`${providerName(row.plugin.provider)} · ${row.plugin.version ?? (row.plugin.kind === 'marketplace' ? 'Marketplace' : 'Version unknown')} · ${enabledText(row.plugin)}`}</Label>
          <Label color={t.textSecondary} size={12} lineHeight={18}>{contentsText(row.plugin)}</Label>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>{row.cells.map(c => <StatusChip key={c.machine.id} tone={c.state === 'different' ? 'warning' : 'neutral'} lead={<MachineBadge glyph={glyphOfMachine(c.machine.id)} size={12} />}>{`${c.machine.name}: ${c.state === 'same' ? 'Present' : c.state === 'unknown' ? 'Unknown' : c.state === 'missing' ? 'Missing' : 'Different'}`}</StatusChip>)}</div>
          {row.plugin.problem && <Label color={t.textSecondary} size={12} lineHeight={18}>{row.plugin.problem}</Label>}
        </div>
        <Button testId={`plugin-copy-${row.key}`} size="sm" variant="secondary" disabled={!row.cells.some(c => c.plugin && !c.plugin.problem && c.state !== 'unknown')} onClick={() => setReview({view, rows: [row]})}>Copy…</Button>
      </div>)}
      {!rows.length && <Row title="No plugins match" description="Try another filter or refresh after installing a plugin in your agent." />}
      {rows.length > limit && <Row title=""><Button testId="plugins-more" variant="ghost" onClick={() => setLimit(n => n + 50)}>Show more</Button></Row>}
    </Section>
    {jobs.length > 0 && <Section title="Recent copies">{jobs.map(job => <Row key={job.id} title={`${job.plugin_id} → ${view.machines.find(m => m.id === job.target)?.name ?? job.target}`} description={jobText(job)} />)}</Section>}
    {error && <Section title="Could not refresh"><Row title="" description={<ErrorText>{error}</ErrorText>} /></Section>}
    {view.machines.flatMap(m => (m.inventory?.warnings ?? []).map(w => <Section key={`${m.id}:${w}`} title={m.name}><Row title="Inventory incomplete" description={w} /></Section>))}
    {review && <CopyPluginSheet view={review.view} rows={review.rows} targetId={review.target} close={() => {setReview(null);void refreshPlugins()}} inline={inlineSheet} />}
  </>
}
