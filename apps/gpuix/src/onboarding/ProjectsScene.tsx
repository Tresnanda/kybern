// The second scene (SPEC §4): "Bring in your past work." Heading, a two-line lede with rolling numbers, harness chips, the
// import-mode toolbar, the list, and the actions. All state lives in `projectsStore.ts` (the scene mounts and unmounts as the flow
// moves; a scan keeps running and an import keeps going when it is gone). This file only draws and routes.
import { useGpuixRequired, useWindowSize } from '@gpuix/react'
import { useEffect, useMemo, useRef } from 'react'
import { Button } from '../kit/Button.tsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../kit/Empty.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { N } from '../nav/glyphs.ts'
import { TITLEBAR } from '../nav/TitleBar.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Cta, ctaForeground } from './Cta.tsx'
import { Later, SceneHeading, useScenePrimary } from './sceneKit.tsx'
import { skippedTitle } from './skipped.ts'
import { viewSkipped } from './SkippedDialog.tsx'
import { ProjectsChips } from './ProjectsChips.tsx'
import { ProjectsList } from './ProjectsList.tsx'
import { finishFlow, goFrom } from './flow.ts'
import { createPress } from './once.ts'
import { noun } from './model.ts'
import { In, Roll, Words } from './motion.tsx'
import { chipsFor, ctaLabel, failureLine, MODE_CAPTION, MODE_OPTIONS, totalLabel, totals, type CtaLabel } from './projects.ts'
import { allRows, cancelScan, chooseFolder, isEmptyScan, rescan, setMode, startImport, startScan, useProjects } from './projectsStore.ts'
import type { ImportMode } from './model.ts'

const CAL = 'Cal Sans'
const LEDE = 17
const LEDE_LINE = 25
/** The toolbar's height: the 28 px mode switch, 8 px, the 16 px caption. */
const TOOLBAR_H = 52

/** "Found [1,662] chats across [4] agents." (rolling numbers), or the line that holds its place while the first agent reads. */
function Lede({ found, agents, state }: { found: number; agents: number; state: 'looking' | 'found' | 'blank' }) {
  const t = useTheme()
  const word = (text: string) => <Label color={t.textSecondary} size={LEDE} lineHeight={LEDE_LINE} style={{ whiteSpace: 'nowrap' }}>{text}</Label>
  return (
    <SwapOnChange active={state} kind="text" blur={false} style={{ height: LEDE_LINE }}>
      {state === 'found' ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {word('Found')}
          <Roll value={found} size={LEDE} lineHeight={LEDE_LINE} color={t.text} weight={600} />
          {word(`${noun(found, 'chat')} across`)}
          <Roll value={agents} size={LEDE} lineHeight={LEDE_LINE} color={t.text} weight={600} />
          {word(`${noun(agents, 'agent')}.`)}
        </div>
      ) : word(state === 'looking' ? 'Looking through your agents’ chat history…' : ' ')}
    </SwapOnChange>
  )
}

/** "Import [8] projects": the number rolls, the verb and noun swap. The primary takes nodes as its label. */
function CtaContent({ label, color }: { label: CtaLabel; color: string }) {
  const text = (value: string) => <Label color={color} size={15} lineHeight={20} weight={600} style={{ whiteSpace: 'nowrap' }}>{value}</Label>
  return (
    <SwapOnChange active={label.kind === 'import' ? `import:${label.verb}` : label.kind} kind="text" blur={false}>
      {label.kind === 'import' ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {text(label.verb)}
          <Roll value={label.n} size={15} lineHeight={20} color={color} weight={600} />
          <SwapOnChange active={label.noun} kind="text" blur={false}>{text(label.noun)}</SwapOnChange>
        </div>
      ) : text(label.text)}
    </SwapOnChange>
  )
}

function Toolbar({ width }: { width: number }) {
  const t = useTheme()
  const mode = useProjects((s) => s.mode)
  const locked = useProjects((s) => s.job !== null)
  const picked = useProjects((s) => totals(allRows(s), s.selected, s.mode).projects)
  const chats = useProjects((s) => totals(allRows(s), s.selected, s.mode).chats)
  const total = totalLabel({ projects: picked, chats }, mode)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width, gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 4, paddingRight: 8 }}>
        <Label color={t.textSecondary} size={12} lineHeight={16} weight={600} style={{ whiteSpace: 'nowrap' }}>Chats to bring in</Label>
        <Segmented testId="projects-mode" aria-label="Chats to bring in" tone="neutral" busy={locked} options={MODE_OPTIONS} value={mode} onChange={(value) => setMode(value as ImportMode)} />
        <div style={{ flexGrow: 1 }} />
        <SwapOnChange active={total.kind} kind="text" blur={false} style={{ justifyContent: 'flex-end', height: 20 }} innerStyle={{ justifyContent: 'flex-end' }} leavingStyle={{ right: 0, justifyContent: 'flex-end' }}>
          {total.kind === 'chats' ? (
            <div testId="projects-total" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Roll value={total.chats} size={12.5} lineHeight={20} color={t.text} weight={600} />
              <Label color={t.textSecondary} size={12.5} lineHeight={20} style={{ whiteSpace: 'nowrap' }}>{total.noun}</Label>
            </div>
          ) : total.kind === 'projects-only' ? (
            <Label color={t.textSecondary} size={12.5} lineHeight={20} style={{ whiteSpace: 'nowrap' }}>Projects only</Label>
          ) : <Label color={t.textSecondary} size={12.5} lineHeight={20}>{' '}</Label>}
        </SwapOnChange>
      </div>
      <SwapOnChange active={mode} kind="text" blur={false} style={{ justifyContent: 'flex-start', width: '100%', minHeight: 16 }} innerStyle={{ justifyContent: 'flex-start' }}>
        <Label color={t.textTertiary} size={12} lineHeight={16} style={{ paddingLeft: 8 }}>{MODE_CAPTION[mode]}</Label>
      </SwapOnChange>
    </div>
  )
}

export function ProjectsScene() {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const size = useWindowSize({ intervalMs: 300 })
  const width = size?.width ?? 1440
  const height = size?.height ?? 900
  // Once per flow run: the Agents scene may already have started it.
  useEffect(() => { startScan() }, [])

  const status = useProjects((s) => s.status)
  const providers = useProjects((s) => s.scan?.providers)
  const found = useProjects((s) => s.scan?.sessions_found ?? 0)
  const scanError = useProjects((s) => s.scanError)
  const empty = useProjects(isEmptyScan)
  const hasRows = useProjects((s) => s.suggested.length + s.others.length > 0)
  const mode = useProjects((s) => s.mode)
  const picked = useProjects((s) => totals(allRows(s), s.selected, s.mode).projects)
  const job = useProjects((s) => s.job)
  const progress = useProjects((s) => s.progress)
  const importError = useProjects((s) => s.importError)
  const skipped = useProjects((s) => s.summary.skipped)

  const sceneAt = useRef(Date.now())
  const chips = useMemo(() => chipsFor(providers ?? []), [providers])
  const agents = chips.chips.filter((c) => c.sessions > 0).length
  const importing = job !== null
  const failedView = status === 'failed' && !hasRows
  const lede = found > 0 ? 'found' : status === 'scanning' || status === 'idle' ? 'looking' : 'blank'
  const label = ctaLabel(mode, picked, importing)

  const col = Math.max(320, Math.min(720, width - 48))
  const headSize = width < 760 ? 36 : 44
  const top = Math.round(Math.min(84, Math.max(TITLEBAR + 8, height * 0.09)))
  const failure = chips.failed.length > 0 ? failureLine(chips.failed) : ''

  const choose = () => { void chooseFolder(renderer) }
  const freeChat = () => { cancelScan(); finishFlow('free', null) }
  const leave = () => { goFrom('projects', 'prefs') }
  // A double click on Import must start the import once and not also walk on to Preferences.
  const press = useRef(createPress(600)).current
  const primary = () => press(() => {
    if (!importing && picked > 0) { startImport(); return }
    leave()
  })
  useScenePrimary('projects', primary)

  const emptyBody = (
    <Empty testId="projects-empty" style={{ padding: 24 }}>
      <EmptyHeader>
        <EmptyMedia variant="icon" icon={N.folder} />
        <EmptyTitle>No past chats found</EmptyTitle>
        <EmptyDescription>Your agents have no chat history on this Mac yet. Choose a folder to work in, or start a free chat.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
        <Button testId="projects-empty-folder" variant="secondary" size="lg" icon={N.folder} onClick={choose}>Choose a folder</Button>
        <Button testId="projects-empty-free" variant="ghost" size="lg" icon={N.newThread} onClick={freeChat}>Start a free chat</Button>
      </EmptyContent>
    </Empty>
  )
  const failedBody = (
    <Empty testId="projects-failed" style={{ padding: 24 }}>
      <EmptyHeader>
        <EmptyMedia variant="icon" icon={N.alert} />
        <EmptyTitle>Couldn’t read your chat history</EmptyTitle>
        <EmptyDescription>{scanError ? `${scanError} Scan again, or choose a folder to work in.` : 'Scan again, or choose a folder to work in.'}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
        <Button testId="projects-rescan" variant="secondary" size="lg" onClick={() => rescan()}>Scan again</Button>
        <Button testId="projects-failed-folder" variant="ghost" size="lg" icon={N.folder} onClick={choose}>Choose a folder</Button>
      </EmptyContent>
    </Empty>
  )

  return (
    <div testId="projects-scene" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: top, paddingBottom: 28, paddingLeft: 24, paddingRight: 24 }}>
      <SceneHeading id="projects" label="Bring in your past work."><Words lines={[['Bring', 'in', 'your', 'past', 'work.']]} size={headSize} lineHeight={Math.round(headSize * 1.1)} color={t.text} font={CAL} base={0.2} /></SceneHeading>
      <In delay={0.62} y={10} style={{ alignItems: 'center', marginTop: 14 }}>
        <Lede found={found} agents={agents} state={lede} />
        <SwapOnChange active={empty || failedView ? 'blank' : 'pick'} kind="text" blur={false} style={{ height: LEDE_LINE }}>
          <Label color={t.textSecondary} size={LEDE} lineHeight={LEDE_LINE}>{empty || failedView ? ' ' : 'Pick the projects to bring in.'}</Label>
        </SwapOnChange>
      </In>

      {!empty && !failedView && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 18, gap: 10 }}>
          <Later frames={1} placeholder={<div style={{ height: 32 }} />}><ProjectsChips data={chips} since={sceneAt.current} /></Later>
          {failure && status !== 'scanning' && (
            <In y={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Label color={t.textSecondary} size={13} lineHeight={18}>{failure}</Label>
              <Button testId="projects-rescan" variant="ghost" size="sm" onClick={() => rescan()}>Scan again</Button>
            </In>
          )}
        </div>
      )}

      {empty || failedView ? (
        <In delay={0.8} y={10} style={{ width: col, flexGrow: 1, minHeight: 0, justifyContent: 'center' }}>{empty ? emptyBody : failedBody}</In>
      ) : (
        <>
          <In delay={0.85} y={10} style={{ width: col, marginTop: 20 }}><Later frames={2} placeholder={<div style={{ height: TOOLBAR_H }} />}><Toolbar width={col} /></Later></In>
          <In delay={0.95} y={10} style={{ width: col, flexGrow: 1, minHeight: 0, marginTop: 10 }}><Later frames={3}><ProjectsList rowWidth={col - 8} /></Later></In>
        </>
      )}

      {importError && <Label color={t.red} size={12} lineHeight={16} style={{ marginTop: 8 }}>{importError}</Label>}
      {skipped > 0 && (
        <In y={6} style={{ width: col, marginTop: 10, paddingLeft: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Label color={t.textSecondary} size={13} lineHeight={18} style={{ whiteSpace: 'nowrap' }}>{`${skippedTitle(skipped)}.`}</Label>
          <Button testId="projects-view-skipped" variant="ghost" size="sm" onClick={viewSkipped}>View skipped</Button>
        </In>
      )}
      <In delay={1.05} y={10} style={{ width: col, marginTop: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Button testId="projects-back" variant="ghost" size="lg" icon={N.arrowLeft} onClick={() => goFrom('projects', 'agents')}>Back</Button>
          {!empty && !failedView && (
            <div style={{ display: 'flex', flexDirection: 'row', gap: 2, opacity: importing ? 0 : 1, ...(importing ? { pointerEvents: 'none' as const } : {}) }}>
              <Button testId="projects-choose-folder" variant="ghost" size="lg" icon={N.folder} disabled={importing} onClick={choose}>Choose a folder</Button>
              <Button testId="projects-free-chat" variant="ghost" size="lg" icon={N.newThread} disabled={importing} onClick={freeChat}>Start a free chat</Button>
            </div>
          )}
          <div style={{ flexGrow: 1 }} />
          <Cta testId="projects-primary" onClick={primary} progress={importing ? progress : undefined}><CtaContent label={label} color={ctaForeground(t)} /></Cta>
        </div>
      </In>
    </div>
  )
}
