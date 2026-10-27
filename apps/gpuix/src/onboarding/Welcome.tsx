// The first-run surface (SPEC §0): one window-sized layer over the app shell, mounted while the flow is open. A flat canvas with a
// dot grid, a progress label on the right, and one scene at a time. Each scene change pushes the next in and pulls the last out;
// Back mid-flight reverses from where each is on screen (`Presence`). `finishFlow` dissolves the whole layer into the app.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useEffect, useRef, useState } from 'react'
import { EASE } from '../motion/tokens.ts'
import { Presence, type Exit } from '../motion/Presence.tsx'
import { Swap } from '../motion/kit.tsx'
import { FILL_ISLAND, ISLAND } from '../MatrixLoader.tsx'
import { TITLEBAR } from '../nav/TitleBar.tsx'
import { useWindowControlsLayout, WindowControls } from '../nav/WindowControls.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { useApp } from '../state.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { AgentsScene } from './AgentsScene.tsx'
import { Grid, canvasColor, litPointer } from './Grid.tsx'
import { Hero } from './Hero.tsx'
import { PreferencesScene } from './PreferencesScene.tsx'
import { ProjectsScene } from './ProjectsScene.tsx'
import { SCENE_ORDER, SCENE_TITLE, flow, noteReturningUser, openFlow, useFlow, wantsOnboarding, type SceneId } from './flow.ts'
import './lifecycle.ts'
import { magnetPointer } from './magnet.ts'
import { bez } from './motion.tsx'

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
export function OnboardingLayer({ show }: { show: boolean }) {
  // Retained from the start of the handoff (the welcome still opaque over the app drawing under it), so the fade's first frame is
  // paint-only instead of a full window render.
  const releasing = useFlow((s) => s.releasing)
  return (
    <IslandPresence show={show} retainAtRest={releasing} exit={{ to: { opacity: 0, scale: 1.015 }, duration: 0.6, ease: EASE.out }}>
      <Welcome />
    </IslandPresence>
  )
}

/**
 * A window-filling layer that enters and leaves (`Presence`) inside its own cached island, in that order: island outside, transform
 * scope inside, and no scope at all at rest (unless `retainAtRest`). An island that replays inside a scope (the layer or a scene held at identity, a scene
 * mid-entrance) loses the scopes nested in it on an addon without the fork's nested-replay fix, so everything held at a retained
 * opacity of 0 or mid-rise in it would present at full opacity for that frame: the outgoing and incoming scenes flashing together.
 */
function IslandPresence({ show, enter, exit, retainAtRest = false, children }: { show: boolean; enter?: PaintTransformProps; exit: Exit; retainAtRest?: boolean; children: React.ReactNode }) {
  const [present, setPresent] = useState(show)
  if (show && !present) setPresent(true)
  if (!present) return null
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', ...(show ? {} : { pointerEvents: 'none' }) }}>
      <div {...FILL_ISLAND} style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Presence show={show} enter={enter} exit={exit} retainAtRest={retainAtRest} onGone={() => setPresent(false)} style={{ flexGrow: 1, minHeight: 0 }}>
          {children}
        </Presence>
      </div>
    </div>
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
  // Each scene is its own cached island: a commit in one scene lays out that scene alone, and while two are on screen the one that
  // is leaving only replays its paint (retained exit frames update it in place). Unmounted when its exit ends.
  return (
    <IslandPresence show={current} enter={sceneEnter(mounted.current.dir, first.current)} exit={sceneExit(dir)}>
      <View />
    </IslandPresence>
  )
}

function Welcome() {
  const t = useTheme()
  const { trailing } = useWindowControlsLayout()
  return (
    <div testId="onboarding" onMouseMove={(e) => { litPointer(e.x ?? null, e.y ?? null); magnetPointer(e.x ?? null, e.y ?? null) }} onMouseLeave={() => { litPointer(null, null); magnetPointer(null, null) }} style={{ position: 'relative', flexGrow: 1, minHeight: 0, backgroundColor: canvasColor(t), overflow: 'hidden' }}>
      <Grid />
      {SCENE_ORDER.map((id) => <SceneLayer key={id} id={id} />)}
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
      <Swap active={label} kind="text" blur={false}>
        <Label color={t.textSecondary} size={12.5} lineHeight={16} weight={500} style={{ whiteSpace: 'nowrap' }}>{label || ' '}</Label>
      </Swap>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
        {[1, 2, 3].map((n) => (
          <div key={n} style={{ position: 'relative', width: 28, height: 4, borderRadius: 2, backgroundColor: t.variant === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(13, 13, 13, 0.1)', overflow: 'hidden' }}>
            <div
              paintTransform={PATCHED_NATIVE ? { initial: false, animate: { scaleX: step >= n ? 1 : 0.001, opacity: step >= n ? 1 : 0 }, transition: { duration: 0.5, ease: bez(EASE.out) }, origin: [0, 0.5], retain: true } : undefined}
              style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 2, backgroundColor: t.text, ...(PATCHED_NATIVE ? {} : { opacity: step >= n ? 1 : 0 }) }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

