import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MachinePlugin, PluginsNetworkView, PluginsMachineView, PluginCopyOutcome } from '../../../../packages/kybern-client/src/types.ts'
import { contentsText, enabledText, pluginCopyRequest, pluginKey, providerName, jobText, type PluginRow } from '../../../../packages/kybern-client/src/pluginSync.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Button } from '../kit/Button.tsx'
import { Card } from '../kit/Card.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { Select } from '../kit/Select.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { errorText } from '../nav/actions.ts'
import { useControls } from '../kit/controls.ts'
import { copyPlugin, pluginsClient } from './store.ts'
import { isWindowVisible } from '../native/visibility.ts'

interface Plan {source: PluginsMachineView; plugin: MachinePlugin}
function InlineFrame({ children, testId }: { children: ReactNode; testId?: string; onClose: () => void; width: number }) {
  const t = useTheme(), c = useControls()
  return <div testId={testId} style={{display: 'flex', flexDirection: 'column', width: 600, maxHeight: 880, alignSelf: 'center', borderRadius: 16, borderWidth: 1, borderColor: c.ink(.1), backgroundColor: t.v('--popover')}}>{children}</div>
}

export function CopyPluginSheet({view, rows, targetId, close, inline = false}: {view: PluginsNetworkView; rows: PluginRow[]; targetId?: string; close: () => void; inline?: boolean}) {
  const t = useTheme(), Frame = inline ? InlineFrame : Dialog
  const single = rows.length === 1
  const sources = single ? rows[0]!.cells.filter(c => c.plugin && !c.plugin.problem && c.state !== 'unknown').map(c => c.machine) : []
  const [sourceId, setSource] = useState(sources.find(m => m.is_self)?.id ?? sources[0]?.id)
  const plans = useMemo<Plan[]>(() => rows.flatMap(row => {
    const cell = single ? row.cells.find(c => c.machine.id === sourceId) : row.cells.find(c => c.plugin && !c.plugin.problem && c.state === 'same')
    return cell?.plugin ? [{source: cell.machine, plugin: cell.plugin}] : []
  }), [rows, sourceId, single])
  const targets = view.machines.filter(m => (!single || m.id !== sourceId) && (m.state === 'reported' || m.state === 'offline'))
  const [chosen, setChosen] = useState(new Set(targetId ? [targetId] : targets.filter(m => rows.every(r => r.cells.some(c => c.machine.id === m.id && c.state === 'missing'))).map(m => m.id)))
  const [replace, setReplace] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [results, setResults] = useState<(PluginCopyOutcome & {plugin: string})[] | null>(null)
  const [live, setLive] = useState<PluginsNetworkView | null>(null)
  const selected = targets.filter(m => chosen.has(m.id))
  const differs = plans.some(p => selected.some(m => m.inventory?.plugins.some(other => pluginKey(other) === pluginKey(p.plugin) && other.fingerprint !== p.plugin.fingerprint)))
  const toggle = (id: string, on: boolean) => setChosen(before => {const next = new Set(before);if(on) next.add(id);else next.delete(id);return next})
  const dismiss = () => {if (!busy) close()}
  const confirm = async () => {
    setBusy(true);setError('')
    const done: (PluginCopyOutcome & {plugin: string})[] = []
    try {
      for (const plan of plans) {
        try { const result = await copyPlugin(pluginCopyRequest(plan.source, plan.plugin, selected.filter(m => m.id !== plan.source.id), view, replace)); done.push(...result.targets.map(t => ({...t, plugin: plan.plugin.name}))) }
        catch (e) {done.push({machine: '', name: plan.source.name, plugin: plan.plugin.name, outbox_id: null, result: null, error: errorText(e)})}
      }
      setResults(done)
    } finally {setBusy(false)}
  }
  // Remote-source jobs are read from that source's inventory; outbox notifications alone are local.
  useEffect(() => {
    if (!results?.some(r => r.outbox_id)) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (stopped) return
      try {
        if (isWindowVisible()) {
          const next = await pluginsClient()?.call('plugins.network_view', {})
          if (!stopped && next) {
            setLive(next)
            const jobs = next.machines.flatMap(m => m.inventory?.jobs ?? [])
            if (results.every(r => !r.outbox_id || jobs.some(j => j.id === r.outbox_id && j.state !== 'queued' && j.state !== 'sending'))) return
          }
        }
      } catch { /* Keep the submitted jobs visible; Refresh can retry after reconnect. */ }
      if (!stopped) timer = setTimeout(() => void read(), 3000)
    }
    void read();return () => {stopped = true;clearTimeout(timer)}
  }, [results])
  return <Frame testId="plugin-copy-sheet" onClose={dismiss} width={600}>
    <DialogHeader title={results ? 'Copy results' : single ? `Copy ${plans[0]?.plugin.name ?? 'plugin'}` : `Copy ${rows.length} missing plugins and sources`} description={results ? 'Queued installs continue when the target is reachable. Results also appear on the Plugins page.' : 'Review what each plugin brings. Its agent installs it on the target; plugin code can run hooks, tools and servers.'} onClose={dismiss} />
    <DialogBody scroll>
      {results ? <div testId="plugin-copy-results" style={{display: 'flex', flexDirection: 'column', gap: 12}}>{results.map((r, i) => {
        const job = live?.machines.flatMap(m => m.inventory?.jobs ?? []).find(j => j.id === r.outbox_id)
        const message = job ? jobText(job) : r.result?.message ?? r.error ?? 'Queued · installs when reachable'
        return <Card key={i} tone={r.error || r.result?.state === 'failed' || job?.result?.state === 'failed' || job?.state === 'failed' ? 'danger' : 'neutral'}><Label color={t.text} size={14} weight={500}>{`${r.plugin} → ${r.name}`}</Label><Hint>{message}</Hint></Card>
      })}</div> : <>
        <Field label="From">{single ? <Select testId="plugin-source" label="Source machine" value={sourceId} options={sources.map(m => ({value: m.id, label: m.name}))} onValueChange={v => {setSource(v);setChosen(new Set());setReplace(false)}} /> : <Hint>Each plugin uses the source listed below.</Hint>}</Field>
        <Field label="What will be installed">{plans.map(({source, plugin}) => <Card key={pluginKey(plugin)}>
          <Label color={t.text} size={14} weight={500}>{`${plugin.name} · ${providerName(plugin.provider)}`}</Label>
          <Hint>{`${plugin.version ?? 'Version chosen by the agent'} · ${enabledText(plugin)} · from ${source.name}`}</Hint>
          <Label color={t.text} size={13} lineHeight={20}>{contentsText(plugin)}</Label>
          <Hint>{plugin.source ?? 'Source unavailable'}</Hint>
          {Object.keys(plugin.resources).length > 0 && <Hint>{`Resource filters: ${Object.entries(plugin.resources).map(([key, values]) => `${key}: ${values.join(', ') || 'none'}`).join(' · ')}`}</Hint>}
          {plugin.contents.notes.map((note, i) => <Label key={i} color={t.textSecondary} size={12} lineHeight={18}>{note}</Label>)}
        </Card>)}</Field>
        <Field label="To">{targets.map(m => {
          const existing = plans.map(p => m.inventory?.plugins.find(v => pluginKey(v) === pluginKey(p.plugin))).filter(Boolean)
          const different = existing.some(p => plans.some(plan => pluginKey(plan.plugin) === pluginKey(p!) && plan.plugin.fingerprint !== p!.fingerprint))
          const unknown = !m.inventory || plans.some(p => m.inventory!.warnings.some(w => w.startsWith(p.plugin.provider)))
          return <div key={m.id} style={{display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6}}>
            <Checkbox testId={`plugin-to-${m.id}`} aria-label={`Copy to ${m.name}`} checked={chosen.has(m.id)} onCheckedChange={on => toggle(m.id, on)} />
            <MachineBadge glyph={glyphOfMachine(m.id)} size={18} />
            <div style={{display: 'flex', flexDirection: 'column', gap: 3}}><Label color={t.text} size={14}>{m.name}</Label><Hint>{m.state === 'offline' ? 'Offline · installs when it returns' : unknown ? 'Unknown · fix the inventory warning on this machine' : different ? `Different · ${existing.map(p => `${p!.version ?? 'unknown version'}, ${enabledText(p!)}`).join('; ')}` : existing.length ? 'Already has this declaration' : 'Missing'}</Hint></div>
          </div>
        })}</Field>
        {differs && <div style={{display: 'flex', gap: 10, alignItems: 'center'}}><Checkbox testId="plugin-replace" aria-label="Replace the different declarations shown" checked={replace} onCheckedChange={setReplace} /><Hint>Replace the different versions and enabled states shown above.</Hint></div>}
        {error && <ErrorText>{error}</ErrorText>}
      </>}
    </DialogBody>
    <DialogFooter><Button testId="plugin-copy-close" variant="secondary" disabled={busy} onClick={dismiss}>{results ? 'Done' : 'Cancel'}</Button>{!results && <Button testId="plugin-copy-confirm" variant="primary" busy={busy} disabled={!plans.length || !selected.length || (differs && !replace)} onClick={() => void confirm()}>{differs ? 'Confirm replacement' : 'Confirm install'}</Button>}</DialogFooter>
  </Frame>
}
