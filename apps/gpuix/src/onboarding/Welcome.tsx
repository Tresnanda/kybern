// The first-run surface (SPEC §0): one window-sized layer over the app shell, mounted while the flow is open. A flat canvas with a
// dot grid, a progress label on the right, and one scene at a time. Each scene change pushes the next in and pulls the last out;
// Back mid-flight reverses from where each is on screen (`Presence`). `finishFlow` dissolves the whole layer into the app.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useWindowSize } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EASE } from '../motion/tokens.ts'
import { Presence, type Exit } from '../motion/Presence.tsx'
import { Swap } from '../motion/kit.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { TITLEBAR } from '../nav/TitleBar.tsx'
import { useWindowControlsLayout, WindowControls } from '../nav/WindowControls.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { useApp } from '../state.ts'
import { Label, LOGO_SVG, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { AgentsScene } from './AgentsScene.tsx'
import { Grid, canvasColor } from './Grid.tsx'
import { Hero } from './Hero.tsx'
import { PreferencesScene } from './PreferencesScene.tsx'
import { ProjectsScene } from './ProjectsScene.tsx'
import { SCENE_ORDER, SCENE_TITLE, flow, noteReturningUser, openFlow, useFlow, wantsOnboarding, type SceneId } from './flow.ts'
import { flight, markRects } from './markFlight.ts'
import { bez, FLIGHT } from './motion.tsx'

/** Whether the layer should be on screen: the gate, latched while the flow runs. Opens the flow the first time it says yes. */
export function useOnboardingGate(): boolean {
  const input = {
    listsLoaded: useApp((s) => s.listsLoaded),
    connected: useApp((s) => s.status === 'open'),
    projects: useApp((s) => s.projects.length),
    threads: useApp((s) => s.threads.length),
    threadOpen: useApp((s) => s.selectedId !== null),
  }
  const open = useFlow((s) => s.open)
  const want = wantsOnboarding(input)
  useEffect(() => {
    if (want && !open) openFlow()
    else if (input.listsLoaded && !want) noteReturningUser(input)
  }, [want, open, input.listsLoaded, input.projects, input.threads])
  return open || want
}

/** The layer itself. `App.tsx` mounts it last in the window, under the dialogs and the toaster. */
export function OnboardingLayer() {
  const show = useOnboardingGate()
  return (
    <Presence
      show={show}
      exit={{ to: { opacity: 0, scale: 1.015 }, duration: 0.6, ease: EASE.out }}
      style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
    >
      <Welcome />
    </Presence>
  )
}

const SCENES: Record<SceneId, () => React.JSX.Element> = { hero: Hero, agents: AgentsScene, projects: ProjectsScene, prefs: PreferencesScene }

function sceneEnter(dir: 1 | -1, first: boolean): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || first) return undefined
  if (REDUCED_MOTION) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.18, ease: bez(EASE.out) } }
  return { initial: { opacity: 0, scale: dir > 0 ? 0.975 : 1.035 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.62, ease: bez(EASE.out) } }
}
const sceneExit = (dir: 1 | -1): Exit => REDUCED_MOTION
  ? { to: { opacity: 0 }, duration: 0.15 }
  : { to: { opacity: 0, scale: dir > 0 ? 1.035 : 0.975 }, duration: 0.3, ease: EASE.out }

function SceneLayer({ id }: { id: SceneId }) {
  const current = useFlow((s) => s.scene === id)
  const mounted = useRef(flow.get())
  const View = SCENES[id]
  const dir = useFlow((s) => s.dir)
  // The first scene on screen appears without a push; later ones push in the direction the flow moved.
  const first = useRef(id === flow.get().scene && !flow.get().introPlayed && id === 'hero')
  return (
    <Presence
      show={current}
      enter={sceneEnter(mounted.current.dir, first.current)}
      exit={sceneExit(dir)}
      style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
    >
      <View />
    </Presence>
  )
}

function Welcome() {
  const t = useTheme()
  const { trailing } = useWindowControlsLayout()
  return (
    <div testId="onboarding" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: canvasColor(t), overflow: 'hidden' }}>
      <Grid />
      {SCENE_ORDER.map((id) => <SceneLayer key={id} id={id} />)}
      <MarkFlight />
      {/* The title strip: drag region, window buttons, and the progress at the right. */}
      <div {...ISLAND} windowDrag testId="onboarding-chrome" style={{ position: 'absolute', left: 0, top: 0, right: 0, height: TITLEBAR }}>
        <WindowControls side="left" />
        <WindowControls side="right" />
        <div style={{ position: 'absolute', top: 0, right: 20 + trailing, height: TITLEBAR, display: 'flex', alignItems: 'center' }}>
          <Progress />
        </div>
      </div>
    </div>
  )
}

/** "Agents · 1 of 3" and three 28×4 segments that fill in as the steps pass (SPEC §0). Hidden on the hero and in the app. */
function Progress() {
  const t = useTheme()
  const scene = useFlow((s) => s.scene)
  const step = scene === 'hero' ? 0 : SCENE_ORDER.indexOf(scene)
  const label = scene === 'hero' ? '' : `${SCENE_TITLE[scene]} · ${step} of 3`
  return (
    <div
      paintTransform={PATCHED_NATIVE ? { initial: false, animate: { opacity: scene === 'hero' ? 0 : 1 }, transition: { duration: 0.4, ease: bez(EASE.out) }, retain: true } : undefined}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <Swap active={label} kind="text">
        <Label color={t.textSecondary} size={12.5} lineHeight={16} weight={500} style={{ whiteSpace: 'nowrap' }}>{label || ' '}</Label>
      </Swap>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
        {[1, 2, 3].map((n) => (
          <div key={n} style={{ position: 'relative', width: 28, height: 4, borderRadius: 2, backgroundColor: t.variant === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(13, 13, 13, 0.1)', overflow: 'hidden' }}>
            <div
              paintTransform={PATCHED_NATIVE ? { initial: false, animate: { scaleX: step >= n ? 1 : 0 }, transition: { duration: 0.5, ease: bez(EASE.out) }, origin: [0, 0.5], retain: true } : undefined}
              style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 2, backgroundColor: t.text, ...(PATCHED_NATIVE ? {} : { opacity: step >= n ? 1 : 0 }) }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The shared mark: a floating copy flies from the hero logo's rect to the hub's, a straight line, 820 ms (SPEC §3e). */
function MarkFlight() {
  const t = useTheme()
  const scene = useFlow((s) => s.scene)
  const dir = useFlow((s) => s.dir)
  const [run, setRun] = useState<{ from: NonNullable<typeof markRects.hero>; to: NonNullable<typeof markRects.hub>; n: number } | null>(null)
  const seen = useRef<SceneId>(scene)
  const n = useRef(0)
  useEffect(() => {
    const previous = seen.current
    seen.current = scene
    if (scene !== 'agents' || previous !== 'hero' || dir < 0 || !PATCHED_NATIVE || REDUCED_MOTION) return
    const from = markRects.hero
    if (!from) return
    flight.set({ flying: true })
    let tries = 0
    const wait = setInterval(() => {
      tries++
      const to = markRects.hub
      if (to) { clearInterval(wait); setRun({ from, to, n: ++n.current }) }
      else if (tries > 15) { clearInterval(wait); flight.set({ flying: false }) }
    }, 20)
    return () => clearInterval(wait)
  }, [scene, dir])
  const size = useWindowSize({ intervalMs: 1000 })
  void size
  const move = useMemo(() => run ? {
    dx: run.to.x + run.to.width / 2 - (run.from.x + run.from.width / 2),
    dy: run.to.y + run.to.height / 2 - (run.from.y + run.from.height / 2),
    s: run.to.width / run.from.width,
  } : null, [run])
  if (!run || !move) return null
  return (
    <div
      key={run.n}
      paintTransform={{ initial: { translateX: 0, translateY: 0, scale: 1 }, animate: { translateX: move.dx, translateY: move.dy, scale: move.s }, transition: { duration: 0.82, ease: bez(FLIGHT) }, generation: run.n }}
      onMotionComplete={(e) => { if (e.motionGeneration === run.n) { setRun(null); flight.set({ flying: false }) } }}
      style={{ position: 'absolute', left: run.from.x, top: run.from.y, width: run.from.width, height: run.from.height, pointerEvents: 'none' }}
    >
      <svg source={LOGO_SVG} style={{ width: run.from.width, height: run.from.height, color: t.text, pointerEvents: 'none' }} />
    </div>
  )
}
