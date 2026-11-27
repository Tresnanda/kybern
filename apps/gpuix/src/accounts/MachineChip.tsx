// One machine on an account row: a `StatusChip`-sized control that says where the account stands there and does the one
// thing that state allows (sign in, or open the actions for that machine).
import { glyph, Icon } from '../icons.tsx'
import { Link01Icon, Share08Icon } from '@hugeicons/core-free-icons'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { S } from '../settings/glyphs.ts'
import { alpha } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { copyText } from '../transcript/store.ts'
import { toast } from '../shell/toasts.tsx'
import { sharingAction, type AccountChip } from './chips.ts'
import { planOnMachine } from './queue.ts'
import { canSignInTerminal, shareSignIns, signIn, signInInstead, signInOn, signInTerminals } from './actions.ts'
import type { UnifiedView } from './store.ts'
import { supportsShared } from './adapter.ts'
import type { UnifiedAccount } from './unified.ts'

const LINK = glyph(Link01Icon)
const SHARE = glyph(Share08Icon)

/** What a person types in that machine's terminal, for a daemon that can't do it from the app. */
export const TERMINAL_COMMANDS: Partial<Record<ProviderKind, { signIn: string; signOut: string }>> = {
  'claude-code': { signIn: 'claude auth login', signOut: 'claude auth logout' },
  codex: { signIn: 'codex login', signOut: 'codex logout' },
  cursor: { signIn: 'cursor-agent login', signOut: 'cursor-agent logout' },
  antigravity: { signIn: 'agy', signOut: 'agy' },
  'grok-build': { signIn: 'grok login', signOut: 'grok logout' },
}

export interface ChipActions {
  signOut: (account: UnifiedAccount, machineId: string) => void
  signOutTerminal: (account: UnifiedAccount, machineId: string, machine: string) => void
}

export function MachineChip({ chip, account, view, actions }: { chip: AccountChip; account: UnifiedAccount; view: UnifiedView; actions: ChipActions }) {
  const machine = view.machines.find((m) => m.machineId === chip.machineId)!
  const standing = chip.standing
  const id = `${account.id}-${chip.machineId}`
  const named = standing?.presences.find((p) => !p.terminal)
  const terminal = standing?.presences.find((p) => p.terminal)
  const shared = supportsShared(machine.features)
  const inTerminal = () => signInTerminals(account.kind, [{ machineId: chip.machineId, machine: chip.machine }])
  const target = { machineId: chip.machineId, name: chip.machine }
  const commands = TERMINAL_COMMANDS[account.kind]
  const copy = (command: string) => { void copyText(command); toast.success(`Copied ${command}`) }
  const share = sharingAction(machine, view.machines, view.sharing?.machineId)
  const shareItem = (separated: boolean) => share && <>
    {separated && <MenuSeparator />}
    <MenuItem id="share" testId={`chip-${share}-${id}`} label={share === 'stop' ? 'Stop sharing' : 'Share this machine’s sign-ins'} onSelect={() => void shareSignIns(share === 'stop' ? null : chip.machineId, chip.machine)} />
  </>

  if (chip.state === 'offline' || (chip.state === 'unknown' && !standing?.terminal)) return <Chip id={id} chip={chip} />
  if (chip.state === 'add') return <Chip id={id} chip={chip} label={`Add to ${chip.machine}`} onClick={() => signInOn(account, target)} />
  if (chip.state === 'signed_out') {
    if (named) return <Chip id={id} chip={chip} label={`Sign in on ${chip.machine}`} onClick={() => signInOn(account, target)} />
    if (canSignInTerminal(account.kind, machine.features)) return <Chip id={id} chip={chip} label={`Sign in the terminal on ${chip.machine}`} onClick={inTerminal} />
    return <ChipMenu id={id} chip={chip}>
      {commands && <><MenuLabel>{`Sign in from a terminal on ${chip.machine}`}</MenuLabel><MenuItem id="copy" testId={`chip-copy-${id}`} label={`Copy ${commands.signIn}`} onSelect={() => copy(commands.signIn)} /></>}
      {shareItem(!!commands)}
    </ChipMenu>
  }
  // Signed in, borrowed, or a borrowed sign-in whose machine is away.
  const hasActions = chip.state === 'terminal_out' || !!standing?.lender || !!named || terminal?.state === 'signed_in'
  return <ChipMenu id={id} chip={chip}>
    {chip.state === 'terminal_out' && (canSignInTerminal(account.kind, machine.features)
      ? <MenuItem id="signin-terminal" testId={`chip-signin-terminal-${id}`} label="Sign in the terminal" onSelect={inTerminal} />
      : commands && <><MenuLabel>{`Sign in from a terminal on ${chip.machine}`}</MenuLabel><MenuItem id="copy-in" testId={`chip-copy-${id}`} label={`Copy ${commands.signIn}`} onSelect={() => copy(commands.signIn)} /></>)}
    {standing?.lender && <MenuItem id="instead" testId={`chip-instead-${id}`} label={`Sign in on ${chip.machine} instead`} onSelect={() => void signInInstead(account, target)} />}
    {!standing?.lender && named && <MenuItem id="again" testId={`chip-again-${id}`} label="Sign in again" onSelect={() => signIn([planOnMachine(account, target)])} />}
    {!standing?.lender && named?.canSignOut && <MenuItem id="signout" testId={`chip-signout-${id}`} label="Sign out…" onSelect={() => actions.signOut(account, chip.machineId)} />}
    {terminal && terminal.state === 'signed_in' && (shared
      ? <MenuItem id="signout-terminal" testId={`chip-signout-terminal-${id}`} label={named ? 'Sign out of the terminal…' : 'Sign out…'} onSelect={() => actions.signOutTerminal(account, chip.machineId, chip.machine)} />
      : commands && <><MenuLabel>{`Sign out in a terminal on ${chip.machine}`}</MenuLabel><MenuItem id="copy-out" testId={`chip-copy-out-${id}`} label={`Copy ${commands.signOut}`} onSelect={() => copy(commands.signOut)} /></>)}
    {shareItem(hasActions)}
  </ChipMenu>
}

function ChipMenu({ id, chip, children }: { id: string; chip: AccountChip; children: React.ReactNode }) {
  return <Menu testId={`chip-menu-${id}`} align="start" minWidth={200} trigger={(open) => <Chip id={id} chip={chip} open={open} menu />}>{children}</Menu>
}

/** The chip itself: 24 px, the tone as a fill, a glyph for the state. */
function Chip({ id, chip, onClick, open, menu, label }: { id: string; chip: AccountChip; onClick?: () => void; open?: boolean; menu?: boolean; label?: string }) {
  const t = useTheme()
  const c = useControls()
  const interactive = !!onClick || !!menu
  const warning = chip.state === 'unreachable' || chip.state === 'signed_out' || chip.state === 'terminal_out'
  const quiet = chip.state === 'add' || chip.state === 'offline'
  const base = t.variant === 'dark' ? '252, 252, 252' : '13, 13, 13'
  const fill = warning ? alpha(t.warning, t.variant === 'dark' ? 0.12 : 0.13) : chip.state === 'add' ? 'transparent' : `rgba(${base}, ${chip.state === 'offline' ? 0.035 : 0.06})`
  const hover = warning ? alpha(t.warning, 0.2) : `rgba(${base}, 0.1)`
  const source = chip.state === 'add' ? N.plus : warning ? S.triangleAlert : chip.state === 'borrowed' ? LINK : chip.terminal ? S.terminal : null
  const color = warning ? t.warning : quiet ? t.textTertiary : t.textSecondary
  const name = `${label ?? chip.label}${chip.lender ? ', shares its sign-ins' : ''}`
  return <div
    testId={`chip-${id}`}
    {...(interactive ? { role: 'button', tabIndex: 0 } : {})}
    aria-label={name}
    {...(onClick ? { onClick, onKeyDown: (e: { key?: string }) => { if (e.key === 'enter' || e.key === 'space') onClick() } } : {})}
    style={{ display: 'flex', alignItems: 'center', gap: 5, height: 24, paddingLeft: source ? 6 : 8, paddingRight: 8, borderRadius: RADIUS.sm - 2, borderWidth: 1, borderColor: chip.state === 'add' ? t.border : 'transparent', backgroundColor: open ? hover : fill, flexShrink: 0, maxWidth: '100%', ...(interactive ? { cursor: 'pointer', hover: { backgroundColor: hover }, focusVisible: { borderColor: c.accent } } : {}) }}
  >
    {source ? <Icon source={source} size={13} color={color} /> : <div style={{ width: 6, height: 6, marginRight: 1, borderRadius: 3, flexShrink: 0, backgroundColor: chip.state === 'signed_in' ? t.v('--success') : t.textTertiary }} />}
    <Label color={quiet ? t.textSecondary : t.text} size={12} lineHeight={16} weight={500} truncate>{chip.label}</Label>
    {chip.lender && <div testId={`chip-lender-${id}`} style={{ display: 'flex', flexShrink: 0 }}><Icon source={SHARE} size={12} color={t.textSecondary} /></div>}
  </div>
}
