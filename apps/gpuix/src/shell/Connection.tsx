import { useEnvironment } from './environment.ts'
// Connection chrome (`App.tsx` `ConnectionBanner` and `Welcome` in the desktop):
//
// - the banner over the content card while the daemon connection is lost:
//   "Reconnecting to {env}…" with a spinner, or the error with a Reconnect
//   button once the transport has given up;
// - the Welcome screen while the first connection is made ("Connecting to
//   {env}"), when the environment is unavailable, and when there is nothing to
//   open yet ("Add a project to begin").
//
// The banner slides in 4px and fades over 200 ms (ease-out) and leaves in 120 ms.
// Under Reduce Motion it only fades. The spinner steps on the shared loader
// clock, so it costs nothing while it is not on screen.
import { motion } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons.tsx'
import { restartLive } from '../nav/live.ts'
import { EASE } from '../motion/kit.tsx'
import { ISLAND, NATIVE_PAINT_ANIMATIONS, useLoaderTime, useLoaderStep } from '../MatrixLoader.tsx'
import { connect, getClient, getState, resetClient, selectThread, set, useApp } from '../state.ts'
import { ink, Label, LOGO_SVG, REDUCED_MOTION, useTheme } from '../ui.tsx'



/** Reconnect after the transport gave up: a fresh client re-reads the port and token (the daemon may have restarted). */
export async function reconnect() {
  const reopen = getState().selectedId
  resetClient()
  set({ status: 'connecting', statusDetail: null })
  await connect()
  const client = getClient()
  if (!client) return
  restartLive()
  if (!reopen) return
  if (client.status === 'open') { void selectThread(reopen); return }
  const stop = client.onStatus((status) => {
    if (status !== 'open') return
    stop()
    void selectThread(reopen)
  })
}

/** The desktop spinner: a continuous rotating arc over a stationary faint ring. */
const SPINNER_RING='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.6"/></svg>'
const SPINNER_ARC='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
export function Spinner({ size = 14, color }: { size?: number; color: string }) {
  return NATIVE_PAINT_ANIMATIONS ? <ContinuousSpinner size={size} color={color} /> : <LegacySpinner size={size} color={color} />
}
const LEGACY_SPINNER = Array.from({ length: 8 }, (_, i) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#000" stroke-opacity="0.2" stroke-width="1.6"/><path d="M14 8a6 6 0 0 0-6-6" stroke="#000" stroke-width="1.6" stroke-linecap="round" transform="rotate(${i * 45} 8 8)"/></svg>`)
function LegacySpinner({ size, color }: { size: number; color: string }) {
  const step = useLoaderStep()
  return <Icon source={LEGACY_SPINNER[step]!} size={size} color={color} />
}
function ContinuousSpinner({ size, color }: { size: number; color: string }) {
  const time = useLoaderTime()
  return <div {...ISLAND} style={{ width: size, height: size, position: 'relative', flexShrink: 0, pointerEvents: 'none' }}>
    <svg source={SPINNER_RING} style={{ width: size, height: size, color, pointerEvents: 'none' }} />
    <svg {...{ rotate: REDUCED_MOTION ? 0 : (time % 1000) * .36 }} source={SPINNER_ARC} style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, color, pointerEvents: 'none' }} />
  </div>
}

type Phase = 'out' | 'in' | 'leaving'

/** Mount once inside the content card; it overlays the top of the card. */
export function ConnectionBanner() {
  const { name: NAME } = useEnvironment()
  const t = useTheme()
  const status = useApp((s) => s.status)
  const detail = useApp((s) => s.statusDetail)
  const show = status === 'reconnecting' || status === 'failed'
  const [phase, setPhase] = useState<Phase>(show ? 'in' : 'out')
  // What the banner said last, so it can finish leaving with its own words.
  const last = useRef({ status, detail })
  if (show) last.current = { status, detail }
  if (show && phase !== 'in') setPhase('in')
  if (!show && phase === 'in') setPhase('leaving')
  if (phase === 'out') return null
  const failed = last.current.status === 'failed'
  const shown = phase === 'in'
  const rise = REDUCED_MOTION ? 0 : -4
  return (
    <div
      testId="connection-banner"
      role="status"
      style={{ position: 'absolute', top: 56, left: 12, right: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}
    >
      <motion.div
        initial={{ opacity: 0, top: rise }}
        animate={{ opacity: shown ? 1 : 0, top: shown ? 0 : rise }}
        transition={{ duration: shown ? 0.2 : 0.12, ease: [...EASE.out] }}
        onMotionComplete={() => {
          if (!shown) setPhase('out')
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          maxWidth: 576,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
          position: 'relative',
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.popover,
          boxShadow: { offsetX: 0, offsetY: 20, blurRadius: 25, spreadRadius: -5, color: 'rgba(0, 0, 0, 0.1)' },
        }}
      >
        {failed ? (
          <>
            <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: t.red }} />
            <Label color={t.text} size={13} lineHeight={21} style={{ flexShrink: 1, minWidth: 0 }}>
              {`${NAME}: ${last.current.detail ?? 'Connection failed'}`}
            </Label>
            <ReconnectButton />
          </>
        ) : (
          <>
            <Spinner size={12} color={t.text} />
            <Label color={t.text} size={13} lineHeight={21} style={{ flexShrink: 1, minWidth: 0 }}>
              {`Reconnecting to ${NAME}…`}
            </Label>
          </>
        )}
      </motion.div>
    </div>
  )
}

/** `Button size="xs" variant="chrome-outline"`: 24px, 12px text, a hairline border. */
function ReconnectButton() {
  const t = useTheme()
  return (
    <div
      testId="connection-reconnect"
      role="button"
      onClick={reconnect}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 24,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: t.border,
        flexShrink: 0,
        pointerEvents: 'auto',
        cursor: 'pointer',
        hover: { backgroundColor: t.buttonSecondaryHover },
        active: { opacity: 0.8 },
      }}
    >
      <Label color={t.text} size={12} weight={500} lineHeight={16}>
        Reconnect
      </Label>
    </div>
  )
}

export type WelcomeKind = 'connecting' | 'unavailable' | 'empty'

/** Which Welcome screen the window shows, if any: nothing once there is a workspace to show. */
export function useWelcome(): WelcomeKind | null {
  const status = useApp((s) => s.status)
  const loaded = useApp((s) => s.listsLoaded)
  const nothing = useApp((s) => s.projects.length === 0 && s.threads.length === 0 && s.selectedId === null)
  if (!loaded) return status === 'failed' || status === 'closed' ? 'unavailable' : 'connecting'
  return status === 'open' && nothing ? 'empty' : null
}

/** The first line of a fresh window: before the daemon answers, and before any project exists. */
export function Welcome({ kind }: { kind: WelcomeKind }) {
  const { name: NAME } = useEnvironment()
  const t = useTheme()
  const [shown, setShown] = useState(false)
  // `DelayedSpinner`: a quick connection never flashes a spinner.
  useEffect(() => {
    if (kind !== 'connecting') return
    const timer = setTimeout(() => setShown(true), 400)
    return () => clearTimeout(timer)
  }, [kind])
  const logo = ink(t, 0.8)
  return (
    <div
      testId="welcome"
      style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingLeft: 24, paddingRight: 24 }}
    >
      <svg source={LOGO_SVG} style={{ width: 40, height: 25, color: logo }} />
      {kind === 'connecting' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', width: 13, height: 13, alignItems: 'center', justifyContent: 'center' }}>
            {shown && <Spinner size={13} color={t.textSecondary} />}
          </div>
          <Label color={t.textSecondary} size={12} lineHeight={16}>
            {`Connecting to ${NAME}`}
          </Label>
        </div>
      ) : kind === 'unavailable' ? (
        <Label color={t.textSecondary} size={14} lineHeight={20}>
          This environment is unavailable. Reconnect or choose another machine.
        </Label>
      ) : (
        <>
          <Label color={ink(t, 0.95)} size={30} lineHeight={34.5}>
            Add a project to begin
          </Label>
          <div style={{ display: 'flex', width: 384, maxWidth: '100%' }}>
            <Label color={ink(t, 0.58 * 0.7)} size={12} lineHeight={16} style={{ textAlign: 'center', width: '100%' }}>
              kybern runs coding agents inside your repositories. Pick a folder and start a thread.
            </Label>
          </div>
        </>
      )}
    </div>
  )
}
