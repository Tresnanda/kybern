// The machine network's intro dialog (`intro.ts` decides when). Two steps in one card, the update details' frame (artwork, 24 px
// corners): what the network is with the four things it unlocks, each drawn with the app's own pieces (machine badges, the
// composer's machine chip), the one requirement and Turn on / Not now; then, once it is on, what happens next and the machines
// as they join. Mounted once in `App.tsx`, beside the update surface.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useEffect, useState, type ReactNode } from 'react'
import { useWindowSize } from '@gpuix/react'
import { ArrowRight02Icon, ArrowUp01Icon, ArrowUpRight01Icon, ComputerTerminal01Icon, GitForkIcon } from '@hugeicons/core-free-icons'
import type { MachineGlyph } from '../../../../packages/kybern-client/src/machineMerge.ts'
import { machineGlyph } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { glyph, Icon } from '../icons.tsx'
import { Dialog, muted } from '../nav/overlay.tsx'
import { surfaceShadow } from '../composer/Menu.tsx'
import { Spinner } from '../shell/Connection.tsx'
import { Button } from '../kit/Button.tsx'
import { toast } from '../shell/toasts.tsx'
import { errorText } from '../nav/actions.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { riseTransform } from '../onboarding/motion.tsx'
import { useFlow } from '../onboarding/flow.ts'
import { useApp, getClient } from '../state.ts'
import { configDir } from '../environments/registry.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { StatusDot } from '../sidebar/MachineFilter.tsx'
import { closeIntro, intro, introAction, introChoice, openIntro, recordIntroChoice, tailscaleNote, useIntro, type IntroStep } from './intro.ts'
import { setNetworkEnabled, useNetwork } from './network.ts'

const ICON = { arrowUp: glyph(ArrowUp01Icon), arrowRight: glyph(ArrowRight02Icon), arrowUpRight: glyph(ArrowUpRight01Icon), terminal: glyph(ComputerTerminal01Icon), fork: glyph(GitForkIcon) }
export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'

/** The branded artwork the update details use (`platform/UpdateSurface.tsx`). */
const ARTWORK = (() => {
  if (process.platform !== 'darwin') return fileURLToPath(new URL('../assets/release-artwork.jpg', import.meta.url))
  const packaged = process.env.KYBERN_GPUIX_RESOURCES && path.join(process.env.KYBERN_GPUIX_RESOURCES, 'release-background.png')
  return packaged && existsSync(packaged) ? packaged : fileURLToPath(new URL('../../../../assets/release-background.png', import.meta.url))
})()

/** Example machines for the pictures: glyphs as the app tints them, names that say what each is. */
const EXAMPLE = {
  windows: { name: 'Windows PC', glyph: machineGlyph({ machineId: 'example-windows-pc', name: 'Windows PC' }) },
  server: { name: 'Linux server', glyph: machineGlyph({ machineId: 'example-linux-server', name: 'Linux server' }) },
  laptop: { name: 'MacBook', glyph: machineGlyph({ machineId: 'example-macbook', name: 'MacBook' }) },
}

/** `KYBERN_NETWORK_INTRO=1` opens it once per run whatever was answered (screenshots, development); `=on` opens the second step. */
const FORCED = process.env.KYBERN_NETWORK_INTRO
/** After the onboarding hands off (or the app connects), the intro waits this long so it never lands on the app's first frames. */
const SETTLE_MS = 1200

/** Decide once per connection whether the intro shows, and mount it while it does. */
export function NetworkIntroSurface() {
  const open = useIntro((s) => s.open)
  const connected = useApp((s) => s.status === 'open')
  const onboarding = useFlow((s) => s.open || s.releasing)
  useEffect(() => {
    if (!connected || onboarding) return
    let gone = false
    const timer = setTimeout(() => void check(() => gone), SETTLE_MS)
    return () => { gone = true; clearTimeout(timer) }
  }, [connected, onboarding])
  return open ? <NetworkIntro /> : null
}

let forcedShown = false
async function check(gone: () => boolean) {
  if (FORCED && !forcedShown) { forcedShown = true; return openIntro(false, FORCED === 'on' ? 'on' : 'intro') }
  const dir = configDir()
  if (intro.get().open || introChoice(dir)) return
  const client = getClient()
  if (!client || client.status !== 'open') return
  let status: NetworkStatus | false
  try { status = await client.call('network.status', {}) } catch { status = false }
  if (gone()) return
  const action = introAction({ decided: !!introChoice(dir), status, onboarding: false })
  if (action === 'record-on') recordIntroChoice(dir, 'already-on')
  if (action === 'show') openIntro(false)
}

function NetworkIntro() {
  const step = useIntro((s) => s.step)
  const fromSettings = useIntro((s) => s.fromSettings)
  const size = useWindowSize({ intervalMs: 250 })
  // Escape, a press outside and the X are "Not now" when it opened by itself.
  const dismiss = () => { if (!fromSettings && step === 'intro') recordIntroChoice(configDir(), 'later'); closeIntro() }
  return <Dialog onClose={dismiss} width={Math.min(560, size.width - 32)} radius={24} testId="network-intro">
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', maxHeight: size.height - 32, minHeight: 0 }}>
      <Hero step={step} />
      <div key={step} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 1 }}>
        {step === 'intro' ? <IntroStepView onDismiss={dismiss} /> : <OnStepView />}
      </div>
    </div>
  </Dialog>
}

/** The artwork with a machine list over it, drawn like the composer's machine picker. */
function Hero({ step }: { step: IntroStep }) {
  const t = useTheme()
  const net = useNetwork()
  const self = net.status?.self_machine
  const selfGlyph = self ? machineGlyph({ machineId: self.machine_id, name: self.name }) : EXAMPLE.laptop.glyph
  const others = (net.status?.members ?? []).filter((member) => !member.is_self)
  const rows: ReactNode[] = [<MachineLine key="self" glyph={selfGlyph} name={self?.name ?? 'This computer'} note="This computer" tone="good" />]
  if (step === 'intro') {
    rows.push(<MachineLine key="w" glyph={EXAMPLE.windows.glyph} name={EXAMPLE.windows.name} note="Online" tone="good" />)
    rows.push(<MachineLine key="s" glyph={EXAMPLE.server.glyph} name={EXAMPLE.server.name} note="Online" tone="good" />)
  } else if (others.length) {
    for (const member of others.slice(0, 3)) rows.push(<MachineLine key={member.machine_id} glyph={machineGlyph({ machineId: member.machine_id, name: member.name })} name={member.name} note="Joined" tone="good" />)
  } else {
    rows.push(<div key="wait" testId="network-intro-waiting" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, paddingLeft: 10, paddingRight: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18 }}><Spinner size={14} color={muted(t, 1)} /></div>
      <Label color={muted(t, 1)} size={13} lineHeight={18}>Looking for your other machines</Label>
    </div>)
  }
  return <div style={{ display: 'flex', position: 'relative', alignItems: 'center', justifyContent: 'center', marginLeft: 12, marginRight: 12, marginTop: 12, height: 176, flexShrink: 0, borderRadius: 16, overflow: 'hidden' }}>
    <img src={ARTWORK} objectFit="cover" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
    <div key={step} paintTransform={riseTransform({ y: 10, scale: 0.98, duration: 0.45 })} style={{ display: 'flex', flexDirection: 'column', width: 264, padding: 4, borderRadius: 14, backgroundColor: t.popover, borderWidth: 1, borderColor: t.border, boxShadow: surfaceShadow(t) }}>
      {rows}
    </div>
  </div>
}

function MachineLine({ glyph: g, name, note, tone }: { glyph: MachineGlyph; name: string; note: string; tone: 'good' | 'warn' }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, paddingLeft: 10, paddingRight: 12 }}>
    <MachineBadge glyph={g} size={18} />
    <Label color={t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{name}</Label>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <StatusDot tone={tone} />
      <Label color={muted(t, 1)} size={12} lineHeight={16}>{note}</Label>
    </div>
  </div>
}

/** A small pill like the composer's machine chip: the real piece each feature puts on screen. */
function Pill({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, paddingLeft: 6, paddingRight: 8, borderRadius: 7, backgroundColor: ink(t, 0.07), flexShrink: 0 }}>{children}</div>
}
function PillText({ children, strong = false }: { children: string; strong?: boolean }) {
  const t = useTheme()
  return <Label color={strong ? t.text : muted(t, 1)} size={12} lineHeight={16} weight={strong ? 500 : 400} style={{ whiteSpace: 'nowrap' }}>{children}</Label>
}

const FEATURES: { id: string; title: string; description: string; piece: () => ReactNode }[] = [
  { id: 'agents', title: 'Run agents on any machine', description: 'Start a chat or hand off a task to whichever machine fits it.',
    piece: () => <Pill><MachineBadge glyph={EXAMPLE.windows.glyph} size={14} /><PillText strong>{EXAMPLE.windows.name}</PillText><PieceIcon source={ICON.arrowUp} /></Pill> },
  { id: 'move', title: 'Fork or continue elsewhere', description: 'Take a thread, with its changes, to another machine.',
    piece: () => <Pill><PieceIcon source={ICON.fork} /><PillText>Continue on</PillText><MachineBadge glyph={EXAMPLE.server.glyph} size={14} /><PillText strong>{EXAMPLE.server.name}</PillText></Pill> },
  { id: 'terminals', title: 'Terminals and previews', description: 'Open a shell or a dev server running on another machine.',
    piece: () => <Pill><PieceIcon source={ICON.terminal} /><PillText strong>zsh</PillText><PillText>on</PillText><MachineBadge glyph={EXAMPLE.laptop.glyph} size={14} /></Pill> },
  { id: 'projects', title: 'Projects, files and sign-ins', description: 'Add a project to another machine. Env files travel encrypted.',
    piece: () => <Pill><MachineBadge glyph={EXAMPLE.laptop.glyph} size={14} /><PieceIcon source={ICON.arrowRight} /><MachineBadge glyph={EXAMPLE.server.glyph} size={14} /><PillText strong>kybern</PillText></Pill> },
]

function PieceIcon({ source }: { source: string }) {
  const t = useTheme()
  return <Icon source={source} size={13} color={muted(t, 1)} />
}

function Feature({ title, description, piece, index }: { title: string; description: string; piece: ReactNode; index: number }) {
  const t = useTheme()
  return <div paintTransform={riseTransform({ y: 8, delay: 0.08 + index * 0.05, duration: 0.4 })} style={{ display: 'flex', flexDirection: 'column', gap: 10, flexBasis: 0, flexGrow: 1, minWidth: 0, padding: 14, borderRadius: 13, backgroundColor: ink(t, 0.035) }}>
    <div style={{ display: 'flex', alignItems: 'center', height: 24 }}>{piece}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>{title}</Label>
      <Label color={muted(t, 1)} size={12} lineHeight={17}>{description}</Label>
    </div>
  </div>
}

function IntroStepView({ onDismiss }: { onDismiss: () => void }) {
  const t = useTheme()
  const net = useNetwork()
  const fromSettings = useIntro((s) => s.fromSettings)
  const busy = net.busy === 'enabled'
  const note = tailscaleNote(net.status?.tailscale)
  const turnOn = () => void setNetworkEnabled(true).then(() => {
    if (!intro.get().fromSettings) recordIntroChoice(configDir(), 'on')
    intro.set({ step: 'on' })
  }, (e) => toast.error('Unable to turn on the network', { description: errorText(e) }))
  return <>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 4, minHeight: 0, flexShrink: 1, overflowY: 'scroll' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Label color={muted(t, 1)} size={12} lineHeight={16} weight={500}>New · Machines</Label>
        <Label color={t.text} size={20} lineHeight={26} weight={500}>Use all your computers from one window</Label>
        <Label color={muted(t, 1)} size={14} lineHeight={22}>Kybern on each of your computers joins one private network over Tailscale, with one sidebar for all of them. Nothing passes through a cloud.</Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>{FEATURES.slice(0, 2).map((f, i) => <Feature key={f.id} title={f.title} description={f.description} piece={f.piece()} index={i} />)}</div>
        <div style={{ display: 'flex', gap: 8 }}>{FEATURES.slice(2).map((f, i) => <Feature key={f.id} title={f.title} description={f.description} piece={f.piece()} index={i + 2} />)}</div>
      </div>
      <Requirement note={note} />
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 16, paddingBottom: 20, flexShrink: 0 }}>
      {net.status?.enabled
        ? <Button size="lg" variant="primary" testId="network-intro-done" onClick={closeIntro}>Done</Button>
        : <>
          <Button size="lg" variant="ghost" testId="network-intro-later" onClick={onDismiss}>{fromSettings ? 'Close' : 'Not now'}</Button>
          <Button size="lg" variant="primary" testId="network-intro-on" busy={busy} onClick={turnOn}>Turn on</Button>
        </>}
    </div>
  </>
}

/** The one requirement, and what this computer has of it. */
function Requirement({ note }: { note: ReturnType<typeof tailscaleNote> }) {
  const t = useTheme()
  const here = note === 'running' ? 'Tailscale is running on this computer.'
    : note === 'stopped' ? 'Tailscale isn’t running on this computer. Open it and sign in.'
    : note === 'missing' ? 'Tailscale isn’t installed on this computer yet.'
    : null
  return <div testId="network-intro-requirement" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 10, paddingTop: 10, paddingBottom: 10, borderRadius: 13, borderWidth: 1, borderColor: ink(t, 0.08) }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>Needs Tailscale on each machine, signed in to one account</Label>
      {here && <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusDot tone={note === 'running' ? 'good' : 'warn'} />
        <Label color={muted(t, 1)} size={12} lineHeight={17}>{here}</Label>
      </div>}
    </div>
    {note === 'missing' && <Button size="sm" variant="secondary" iconAfter={ICON.arrowUpRight} testId="network-intro-tailscale" onClick={() => openUrl(TAILSCALE_DOWNLOAD)}>Get Tailscale</Button>}
  </div>
}

function OnStepView() {
  const t = useTheme()
  const net = useNetwork()
  const joined = (net.status?.members ?? []).filter((member) => !member.is_self).length
  const openMachines = () => { closeIntro(); void import('../settings/SettingsScreen.tsx').then((m) => m.openSettingsTab('machines')) }
  return <>
    <div paintTransform={riseTransform({ y: 8, duration: 0.4 })} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 4 }}>
      <Label color={muted(t, 1)} size={12} lineHeight={16} weight={500}>Machines</Label>
      <Label color={t.text} size={20} lineHeight={26} weight={500}>{joined ? `${joined + 1} machines are connected` : 'Your network is on'}</Label>
      <Label color={muted(t, 1)} size={14} lineHeight={22}>{'Kybern checks your saved pairing and SSH connections. Machines that have never been configured turn on and join over Tailscale; machines you switched off stay off. Open Machines to install Kybern where it is missing or retry a connection.'}</Label>
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 20, flexShrink: 0 }}>
      <Button size="lg" variant="ghost" testId="network-intro-settings" onClick={openMachines}>Open Machines</Button>
      <Button size="lg" variant="primary" testId="network-intro-done" onClick={closeIntro}>Done</Button>
    </div>
  </>
}
