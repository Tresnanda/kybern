// The second scene (SPEC §3): a constellation of the six agents around the Kybern mark, a live line that says what Kybern will
// use, and Back · Set up later · "Continue with N agents". Detection runs for real; the tiles settle as the answers land.
import { useGpuixRequired, useWindowSize, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { Button } from '../kit/Button.tsx'
import { Swap } from '../motion/kit.tsx'
import { N } from '../nav/glyphs.ts'
import { useEnvironment } from '../shell/environment.ts'
import { useAccountsFeed } from '../usage/accounts.ts'
import { Label, useTheme } from '../ui.tsx'
import { AgentPopover } from './AgentPopover.tsx'
import { agents, saveDefaultAgent, startDetection, stopWatching, useAgents, watchLogins } from './agentsStore.ts'
import { Constellation, orbitFor, spotFor } from './Constellation.tsx'
import { Cta, ctaForeground } from './Cta.tsx'
import { toast } from '../shell/toasts.tsx'
import { finishFlow, flow, goFrom } from './flow.ts'
import { createPress } from './once.ts'
import { continueLabel, hostLabel, noun, statusLine } from './model.ts'
import { In, Roll, Words } from './motion.tsx'
import { SceneHeading, useScenePrimary } from './sceneKit.tsx'
import { TerminalSheet } from './TerminalSheet.tsx'

const CAL = 'Cal Sans'
const headingSize = (width: number) => Math.round(Math.min(44, Math.max(30, width * 0.042)))

export function AgentsScene() {
  const t = useTheme()
  const env = useEnvironment()
  const size = useWindowSize({ intervalMs: 300 })
  const width = size?.width ?? 1440, height = size?.height ?? 900
  const view = useAgents()
  const popover = agents.use((s) => s.popover)
  // Coming back from Projects: the same constellation, quicker.
  const quick = useRef(flow.get().dir < 0).current
  useAccountsFeed()
  const orbitBox = useRef<PublicInstance | null>(null)
  const renderer = useGpuixRequired()
  const [rect, setRect] = useState<LayoutRect | null>(null)
  useEffect(() => {
    const node = orbitBox.current
    if (!node) return
    return observeElementBounds(renderer, { id: node.id }, (event) => setRect(event.rect))
  }, [renderer])
  useEffect(() => { startDetection(); watchLogins(); return () => { stopWatching() } }, [])

  const orbit = orbitFor(Math.min(760, width - 48), Math.min(360, Math.round(height * 0.5)))
  const states = Object.fromEntries(view.list.map((a) => [a.kind, a.state]))
  const line = statusLine(states, view.default, hostLabel(process.platform, env.local ? null : env.name))
  const ready = view.ready.length
  const open = view.list.find((a) => a.kind === popover) ?? null
  const spot = open ? spotFor(open.kind, orbit) : null
  const left = (width - orbit.width) / 2
  // Move on first and save in the background: a slow or failed write must neither hold Continue nor let a second press skip a scene.
  const press = useRef(createPress()).current
  const cont = () => press(() => {
    void saveDefaultAgent(view.default).then((saved) => { if (!saved) toast.error('Couldn’t save your default agent.', { description: 'Choose it in Settings › General.' }) })
    goFrom('agents', 'projects')
  })
  const rolled = ready > 0
  const sheet = agents.use((s) => s.sheet)
  // ⌘↵ continues, unless a popover or the terminal sheet has the window.
  useScenePrimary('agents', rolled && !popover && !sheet ? cont : null)
  const fg = ctaForeground(t, !rolled)
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 12 }}>
      <div ref={orbitBox} style={{ width: orbit.width, height: orbit.height, flexShrink: 0 }}>
        <Constellation agents={view.list} ready={ready} defaultKind={view.default} orbit={orbit} quick={quick} />
      </div>
      <div style={{ height: 14 }} />
      <SceneHeading id="agents" label="Your agents, in one place."><Words lines={[['Your', 'agents,', 'in', 'one', 'place.']]} size={headingSize(width)} lineHeight={Math.round(headingSize(width) * 1.1)} color={t.text} font={CAL} base={quick ? 0.1 : 0.5} /></SceneHeading>
      <div style={{ height: 12 }} />
      <In delay={quick ? 0.15 : 0.95} y={8} style={{ alignItems: 'center', width: Math.min(720, width - 48) }}>
        {/* The region's own name is the new line; the Swap inside (the arriving and the leaving copy) is hidden from it, so only the new text is announced. */}
        <div role="status" aria-live="polite" aria-label={line} style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }}>
          <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center' }}>
            <Swap active={line} blur={false} style={{ alignItems: 'flex-start' }}>
              <Label color={t.textSecondary} size={15} lineHeight={22} style={{ textAlign: 'center', width: Math.min(720, width - 48) }}>{line}</Label>
            </Swap>
          </div>
        </div>
      </In>
      <div style={{ height: 12 }} />
      <In delay={quick ? 0.2 : 1.05} y={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Button testId="agents-back" variant="ghost" icon={N.arrowLeft} onClick={() => goFrom('agents', 'hero')}>Back</Button>
        <Button testId="agents-later" variant="ghost" onClick={() => finishFlow('later', null)}>Set up later</Button>
        <Cta testId="agents-continue" disabled={!rolled} onClick={cont}>
          {rolled
            ? <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Label color={fg} size={15} lineHeight={20} weight={600} style={{ whiteSpace: 'nowrap' }}>Continue with</Label>
                <Roll value={ready} size={15} lineHeight={20} color={fg} weight={600} />
                <Swap active={noun(ready, 'agent')} blur={false}><Label color={fg} size={15} lineHeight={20} weight={600} style={{ whiteSpace: 'nowrap' }}>{noun(ready, 'agent')}</Label></Swap>
              </div>
            : continueLabel(0)}
        </Cta>
      </In>
      {/* Above the heading and the actions: a popover from a bottom tile covers them. */}
      <AgentPopover
        agent={open}
        isDefault={!!open && view.default === open.kind}
        x={(rect?.x ?? left) + (spot?.x ?? 0)}
        y={(rect?.y ?? 0) + (spot?.y ?? 0) + 86}
        bounds={{ min: 12, max: width - 12 }}
      />
      <TerminalSheet />
    </div>
  )
}
