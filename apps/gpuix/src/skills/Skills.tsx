// Settings › Skills (ADE-86): your user skills on every machine. Each skill once, with the machines that have it and whether
// their copies match ("Different on os-kdi"); Copy… opens the sheet that sends it. "Copy N missing" per machine copies every
// skill it lacks. Nothing copies by itself. Words come from `packages/kybern-client/src/skillSync.ts`.
import { useMemo, useState } from 'react'
import { SKILL_HOMES, type SkillsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import { filterCounts, machineSummaries, missingRequests, readersText, SKILL_HOME_DETAILS, skillRows, type SkillFilter, type SkillMachineCell, type SkillMachineSummary, type SkillRowModel } from '../../../../packages/kybern-client/src/skillSync.ts'
import { Button } from '../kit/Button.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { toneColor } from '../kit/tone.ts'
import { useControls } from '../kit/controls.ts'
import { Tip } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { ErrorText, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Row, Section } from '../settings/controls.tsx'
import { CopySkillSheet } from './CopySkillSheet.tsx'
import { copySkill, useSkillsView } from './store.ts'

/** Rows shown before "Show more": the page stays light with hundreds of skills. */
const PAGE = 60

export function Skills({ inlineSheet = false }: { inlineSheet?: boolean }) {
  const { view, error, loading } = useSkillsView()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [copying, setCopying] = useState<string | null>(null)
  const rows = useMemo(() => (view ? skillRows(view, query, filter) : []), [view, query, filter])
  const counts = useMemo(() => (view ? filterCounts(view) : { all: 0, different: 0, missing: 0 }), [view])
  if (!view) return <Section title="Skills"><Row title="" description={error ? <ErrorText>{error}</ErrorText> : <Hint>{loading ? 'Reading the skills on your machines…' : 'Connect to a machine to see its skills.'}</Hint>} /></Section>
  const entry = copying ? view.skills.find((skill) => skill.name === copying) ?? null : null
  const several = view.machines.length > 1
  return <>
    {several && <Section title="Machines">
      {machineSummaries(view).map((summary) => <MachineRow key={summary.machine.id} view={view} summary={summary} />)}
    </Section>}
    <Section title="Skills" accessory={several ? <Segmented testId="skills-filter" size="sm" aria-label="Show" value={filter} onChange={(next) => { setFilter(next as SkillFilter); setLimit(PAGE) }} options={[
      { value: 'all', label: 'All', count: counts.all },
      { value: 'different', label: 'Different', count: counts.different },
      { value: 'missing', label: 'Missing', count: counts.missing },
    ]} /> : undefined}>
      <div style={{ display: 'flex', paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10 }}>
        <SearchField testId="skills-search" label="Search skills" placeholder="Search skills" value={query} onChange={(next) => { setQuery(next); setLimit(PAGE) }} width="100%" />
      </div>
      {rows.slice(0, limit).map((row) => <SkillRow key={row.name} row={row} several={several} onCopy={() => setCopying(row.name)} />)}
      {rows.length === 0 && <EmptyRows view={view} query={query} filter={filter} clear={() => { setQuery(''); setFilter('all') }} />}
      {rows.length > limit && <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10, paddingBottom: 10 }}>
        <Button testId="skills-more" size="sm" variant="ghost" onClick={() => setLimit((current) => current + PAGE)}>{`Show ${Math.min(PAGE, rows.length - limit)} more of ${rows.length - limit}`}</Button>
      </div>}
    </Section>
    <Folders view={view} />
    {error && <Section title="Something went wrong"><Row title="" description={<ErrorText>{error}</ErrorText>} /></Section>}
    {entry && <CopySkillSheet key={entry.name} view={view} entry={entry} inline={inlineSheet} close={() => setCopying(null)} />}
  </>
}

/** A machine: how many skills it has, what it lacks, and "Copy N missing". */
function MachineRow({ view, summary }: { view: SkillsNetworkView; summary: SkillMachineSummary }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const { machine, missing } = summary
  const live = machine.state === 'reported'
  const copyMissing = async () => {
    const requests = missingRequests(view, machine.id)
    if (!requests.length) return
    setBusy(true)
    let failed = 0
    for (const request of requests) {
      try { const result = await copySkill(request); failed += result.targets.filter((target) => target.state === 'failed' || target.state === 'unsupported').length }
      catch { failed++ }
    }
    setBusy(false)
    const sent = requests.length - failed
    if (failed) toast.error(`${failed} of ${requests.length} skills weren't copied to ${machine.name}`, { description: 'Open a skill’s Copy… to see why.' })
    else toast(`Copying ${sent === 1 ? '1 skill' : `${sent} skills`} to ${machine.name}`, { description: 'Each one arrives as soon as the machine is reachable.' })
  }
  return <div testId={`skills-machine-${machine.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12 }}>
    <div style={{ display: 'flex', opacity: live ? 1 : 0.5 }}><MachineBadge glyph={glyphOfMachine(machine.id)} size={20} /></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{machine.is_self ? `${machine.name} (this computer)` : machine.name}</Label>
      <Label color={t.textSecondary} size={13} lineHeight={18} truncate>{summary.detail}</Label>
    </div>
    {live && missing.length > 0 && <Button testId={`skills-copy-missing-${machine.id}`} size="sm" variant="secondary" busy={busy} onClick={() => void copyMissing().catch((e) => toast.error('Unable to copy the skills', { description: errorText(e) }))}>{`Copy ${missing.length} missing`}</Button>}
  </div>
}

function SkillRow({ row, several, onCopy }: { row: SkillRowModel; several: boolean; onCopy: () => void }) {
  const t = useTheme()
  const tone = row.status === 'different' ? toneColor(t, 'warning') : row.status === 'missing' ? toneColor(t, 'neutral') : null
  return <div testId={`skill-${row.name}`} style={{ display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 18, paddingRight: 14, paddingTop: 11, paddingBottom: 11 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{row.title}</Label>
      {row.description && <Label color={t.textSecondary} size={13} lineHeight={18} truncate>{row.description}</Label>}
      {several && <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 2 }}>
        {tone && <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: tone }} />}
        <Label color={row.status === 'different' ? t.text : t.textSecondary} size={12.5} lineHeight={17} truncate>{row.statusText}</Label>
      </div>}
    </div>
    {several && <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>{row.cells.map((cell) => <Cell key={cell.machine.id} cell={cell} />)}</div>}
    <Button testId={`skill-copy-${row.name}`} size="sm" variant="secondary" onClick={onCopy}>Copy…</Button>
  </div>
}

const CELL_WORDS: Record<SkillMachineCell['state'], string> = { same: 'Has it', different: 'Has a different version', missing: 'Doesn’t have it', unknown: 'Didn’t report' }

/** A machine's badge for one skill: full for a copy, faint where it is missing or unknown, an amber dot for a different version. */
function Cell({ cell }: { cell: SkillMachineCell }) {
  const t = useTheme()
  const c = useControls()
  const has = cell.state === 'same' || cell.state === 'different'
  const words = cell.pending ? 'A copy is on its way' : CELL_WORDS[cell.state]
  return <Tip label={`${cell.machine.name} · ${words}`}>
    <div aria-label={`${cell.machine.name}: ${words}`} style={{ display: 'flex', position: 'relative', width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', opacity: has ? 1 : 0.28 }}><MachineBadge glyph={glyphOfMachine(cell.machine.id)} size={18} /></div>
      {cell.state === 'different' && <div style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: t.v('--popover'), backgroundColor: toneColor(t, 'warning') }} />}
      {cell.pending && <div style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: t.v('--popover'), backgroundColor: c.accent }} />}
    </div>
  </Tip>
}

function EmptyRows({ view, query, filter, clear }: { view: SkillsNetworkView; query: string; filter: SkillFilter; clear: () => void }) {
  const t = useTheme()
  const filtered = query.trim() !== '' || filter !== 'all'
  if (!view.skills.length) return <Row title="No user skills yet" description="A skill is a folder with a SKILL.md in one of the folders below. Add one there, and it shows up here for every machine." />
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingLeft: 18, paddingRight: 18, paddingTop: 14, paddingBottom: 14 }}>
    <Label color={t.textSecondary} size={14} lineHeight={21}>{query.trim() ? `No skills match “${query.trim()}”.` : filter === 'different' ? 'Every machine has the same version of each skill.' : 'No machine is missing a skill.'}</Label>
    {filtered && <Button testId="skills-clear" size="sm" variant="ghost" onClick={clear}>Show all skills</Button>}
  </div>
}

/** Where skills come from on this machine: each harness folder, who reads it and how many it holds. */
function Folders({ view }: { view: SkillsNetworkView }) {
  const t = useTheme()
  const self = view.machines.find((machine) => machine.is_self)
  const count = (home: string) => view.skills.filter((skill) => skill.machines.some((on) => on.machine_id === self?.id && on.copies.some((copy) => copy.home === home && !copy.linked_to))).length
  return <Section title="Skill folders">
    {SKILL_HOMES.map((home) => {
      const info = self?.homes?.find((item) => item.home === home)
      const n = count(home)
      return <div key={home} testId={`skills-folder-${home}`} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 10, paddingBottom: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Label color={t.text} size={13} lineHeight={19} font={FONT_MONO} truncate>{SKILL_HOME_DETAILS[home].path}</Label>
            {SKILL_HOME_DETAILS[home].universal && <div style={{ display: 'flex', alignItems: 'center', height: 18, paddingLeft: 6, paddingRight: 6, borderRadius: 5, backgroundColor: t.v('--color-background-elevated-secondary') }}><Label color={t.textSecondary} size={11} lineHeight={14} weight={500}>Most agents</Label></div>}
          </div>
          <Label color={t.textSecondary} size={12.5} lineHeight={17} truncate>{`Read by ${readersText(home)}`}</Label>
        </div>
        <Label color={t.textTertiary} size={12.5} lineHeight={17} style={{ flexShrink: 0 }}>{info && !info.exists ? 'Not created' : n === 0 ? 'No skills' : n === 1 ? '1 skill' : `${n} skills`}</Label>
      </div>
    })}
    <Row title="" description={<Hint>Project skills live in each repository and travel with git, so they aren’t listed here.</Hint>} />
  </Section>
}
