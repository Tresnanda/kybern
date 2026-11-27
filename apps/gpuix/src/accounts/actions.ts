// What the account surfaces do. Each action goes to the machine it targets through that machine's own client; the
// shared choices (default, name, "Only when I choose", offer answers) go through `adapter.ts`.
import type { MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { showDialog } from '../dialogs/store.ts'
import { toastProblem } from '../problems/toast.ts'
import { setSettings } from '../settings/store.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient } from '../state.ts'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { refreshAccounts } from '../usage/accounts.ts'
import { setSharing, signOutTerminalLogin, supportsShared, writeShared } from './adapter.ts'
import { TERMINAL_SIGN_IN_KINDS, type Offer } from './offers.ts'
import { requestAntigravitySignIn } from '../antigravity/notice.ts'
import { existingFor, planOnMachine, planSetup, type SignInItem } from './queue.ts'
import { adoptSettings, clientOf, lendableOn, prefsChanged, primaryId, readMachine, refreshAllAccounts, type UnifiedView } from './store.ts'
import { standings, type UnifiedAccount } from './unified.ts'

const list = (names: readonly string[]) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)

/** Change the shared preferences on this window's machine and show the change at once. */
async function change(update: Parameters<typeof writeShared>[1]) {
  const client = getClient()
  if (!client) throw new Error('Not connected to kybernd')
  const saved = await writeShared(client, update)
  if (saved) adoptSettings(saved)
  else prefsChanged()
}

/** Re-read one machine after something changed there. */
async function reread(machineId: MachineId) {
  if (machineId === primaryId()) await refreshAccounts({ probe: true })
  else await readMachine(machineId, { probe: true })
}

/** One default per agent, on every machine. */
export async function makeDefault(view: UnifiedView, account: UnifiedAccount): Promise<boolean> {
  try {
    const away: string[] = []
    if (view.supportsShared && account.key) {
      await change((shared) => ({ ...shared, defaults: { ...shared.defaults, [account.kind]: account.key! } }))
    } else {
      // A daemon that can't share the choice: set it on each machine that has the account.
      for (const standing of standings(account)) {
        if (!standing.online) { away.push(standing.machine); continue }
        const named = standing.presences.find((p) => !p.terminal)
        const client = clientOf(standing.machineId)
        const settings = await client.call('settings.get', {})
        const current = settings.providers[account.kind] ?? { env: {} }
        const saved = await client.call('settings.update', { settings: { ...settings, providers: { ...settings.providers, [account.kind]: { ...current, default_account: named?.instance ?? null } } } })
        if (standing.machineId === primaryId()) setSettings(saved)
        await reread(standing.machineId)
      }
    }
    await refreshAccounts()
    const agent = PROVIDER_NAMES[account.kind] ?? account.kind
    toast.success(away.length ? `${account.name} is now the default for ${agent}. ${list(away)} keeps its default until it’s back.` : `${account.name} is now the default for ${agent}`)
    return true
  } catch (error) {
    toastProblem(error, { action: 'change the default account' })
    return false
  }
}

/** Name, colour and "Only when I choose": the same on every machine. */
export async function setProfile(view: UnifiedView, account: UnifiedAccount, patch: { name?: string; color?: string; manual_only?: boolean }): Promise<void> {
  const key = account.key
  if (view.supportsShared && key) {
    await change((shared) => ({ ...shared, profiles: { ...shared.profiles, [key]: { ...profileFrom(account), ...shared.profiles?.[key], ...patch } } }))
    return
  }
  const { manual_only, ...named } = patch
  if (manual_only !== undefined && key) await change((shared) => ({ ...shared, profiles: { ...shared.profiles, [key]: { ...shared.profiles?.[key], manual_only } } }))
  if (named.name === undefined && named.color === undefined) return
  for (const presence of account.presences.filter((p) => !p.terminal && p.online)) {
    await clientOf(presence.machineId).call('providers.accounts.update', { kind: account.kind, instance: presence.instance, ...named })
    await reread(presence.machineId)
  }
}
const profileFrom = (account: UnifiedAccount) => ({ name: account.name, ...(account.color ? { color: account.color } : {}), manual_only: account.manualOnly })

/** Whether this account can take a name and a colour here. */
export const canStyle = (view: UnifiedView, account: UnifiedAccount) => (view.supportsShared && !!account.key) || account.presences.some((p) => !p.terminal)

/** Run `act` on each machine, saying which ones failed. */
async function onEach(account: UnifiedAccount, machines: readonly MachineId[], action: string, act: (machineId: MachineId, instance: string) => Promise<unknown>) {
  let failed = false
  for (const machineId of machines) {
    try {
      for (const presence of account.presences.filter((p) => p.machineId === machineId && !p.terminal)) await act(machineId, presence.instance)
      await reread(machineId)
    } catch (error) {
      failed = true
      const name = account.presences.find((p) => p.machineId === machineId)?.machine ?? 'that machine'
      // The daemon says when a turn is still running ("Work is running in 2 threads. Stop them, then remove it.").
      toastProblem(error, { action: `${action} ${account.name} on ${name}` })
    }
  }
  return !failed
}

export async function removeFrom(account: UnifiedAccount, machines: readonly MachineId[]) {
  const done = await onEach(account, machines, 'remove', (machineId, instance) => clientOf(machineId).call('providers.accounts.remove', { kind: account.kind, instance }))
  if (done) toast.success(`${account.name} removed`)
  return done
}

export async function signOutOn(account: UnifiedAccount, machines: readonly MachineId[]) {
  const done = await onEach(account, machines, 'sign out', (machineId, instance) => clientOf(machineId).call('providers.accounts.sign_out', { kind: account.kind, instance }))
  if (done) toast.success(`${account.name} signed out`)
  return done
}

export async function signOutTerminalOn(kind: ProviderKind, machineId: MachineId, machine: string) {
  try {
    await signOutTerminalLogin(clientOf(machineId), kind)
    await reread(machineId)
    toast.success(`Signed out the terminal login on ${machine}`)
    return true
  } catch (error) {
    toastProblem(error, { action: `sign out the terminal login on ${machine}` })
    return false
  }
}

/** Borrow a shared sign-in into a local account: reuse the machine's account of that email, else make one. A refused
 *  borrow takes the account it made away again, so trying again or signing in there starts clean. */
export async function borrow(view: UnifiedView, item: SignInItem, connect = clientOf): Promise<void> {
  const lender = item.lender
  if (!lender) throw new Error('There is no sign-in to borrow')
  const client = connect(item.machineId)
  const machine = view.machines.find((m) => m.machineId === item.machineId)
  const existing = item.instance && item.instance !== 'default' ? item.instance : existingFor(machine?.accounts ?? [], item.kind, item.email)?.provider.instance
  const instance = existing ?? (await client.call('providers.accounts.create', { kind: item.kind, name: item.name ?? item.email ?? lender.account })).instance
  try {
    await client.call('login.broker.bind', { provider: item.kind, instance, broker_account: lender.account })
  } catch (error) {
    // The refusal is what the person needs to see, even if tidying up fails too.
    if (!existing) await client.call('providers.accounts.remove', { kind: item.kind, instance }).catch(() => {})
    throw error
  }
  await reread(item.machineId)
}

/** Before a login signs in itself: one that borrows would keep borrowing afterwards, so it stops first. */
export async function stopBorrowing(view: UnifiedView, item: Pick<SignInItem, 'machineId' | 'kind' | 'instance'>, connect = clientOf): Promise<void> {
  const login = view.machines.find((m) => m.machineId === item.machineId)?.accounts.find((a) => a.provider.kind === item.kind && a.provider.instance === item.instance)
  if (!login?.broker || login.broker.state === 'lending') return
  await connect(item.machineId).call('login.broker.bind', { provider: item.kind, instance: login.provider.instance, broker_account: null })
}

/** Open the sign-in queue for these steps. */
export function signIn(items: readonly SignInItem[]) {
  if (items.length) showDialog({ kind: 'account', items: [...items] })
}

export const signInOn = (account: UnifiedAccount, machine: { machineId: MachineId; name: string }) => signIn([planOnMachine(account, machine)])

/** Whether Kybern can sign that machine's terminal login in: Antigravity always could; the others need a newer daemon. */
export const canSignInTerminal = (kind: ProviderKind, features: readonly string[]) =>
  kind === 'antigravity' || (supportsShared(features) && TERMINAL_SIGN_IN_KINDS.includes(kind))

/** Sign the terminal login in on each of these machines, one after another (after Google's notice for Antigravity). */
export function signInTerminals(kind: ProviderKind, machines: readonly { machineId: MachineId; machine: string }[]) {
  const items = machines.map(({ machineId, machine }): SignInItem => ({ id: `${machineId}:${kind}:default`, machineId, machine, kind, method: 'sign_in', ...(kind === 'antigravity' ? { ownLogin: true } : { instance: 'default' }) }))
  if (kind === 'antigravity') requestAntigravitySignIn(() => signIn(items))
  else signIn(items)
}

/** "Sign in here instead": stop borrowing, then sign this machine in itself. */
export async function signInInstead(account: UnifiedAccount, machine: { machineId: MachineId; name: string }) {
  const presence = account.presences.find((p) => p.machineId === machine.machineId && p.lender)
  if (!presence) return signInOn(account, machine)
  try {
    await clientOf(machine.machineId).call('login.broker.bind', { provider: account.kind, instance: presence.instance, broker_account: null })
    await reread(machine.machineId)
    signIn([{ ...planOnMachine(account, machine), instance: presence.instance }])
  } catch (error) {
    toastProblem(error, { action: `sign ${account.name} in on ${machine.name}` })
  }
}

export async function shareSignIns(machineId: MachineId | null, name: string, via?: 'always_on') {
  try {
    const client = getClient()
    if (!client) throw new Error('Not connected to kybernd')
    await setSharing(client, machineId, via)
    await refreshAllAccounts()
    toast.success(machineId ? `Your machines can use ${name}’s sign-ins` : `${name} stopped sharing its sign-ins`)
    return true
  } catch (error) {
    toastProblem(error, { action: machineId ? `share ${name}’s sign-ins` : `stop sharing ${name}’s sign-ins` })
    return false
  }
}

export async function answerOffer(offer: Offer, state: 'later' | 'never') {
  try {
    await change((shared) => ({ ...shared, offers: { ...shared.offers, [offer.id]: { state, fingerprint: offer.fingerprint } } }))
  } catch (error) {
    toastProblem(error, { action: 'dismiss that suggestion' })
  }
}

/** The steps "Set up" runs for a new machine: what it is missing, borrowed where possible. */
export function setupItems(view: UnifiedView, offer: Offer): SignInItem[] {
  const accounts = view.groups.flatMap((group) => group.accounts).filter((account) => account.key && (offer.keys ?? []).includes(account.key))
  const sharing = view.sharing && { ...view.sharing, lendable: lendableOn(view.groups, view.sharing.machineId) }
  return planSetup(accounts, { machineId: offer.machine_id, name: offer.machine_name }, sharing)
}

/** Do what a card offers. `change` is a clash's "Change". */
export async function acceptOffer(view: UnifiedView, offer: Offer, answer: 'accept' | 'change' = 'accept'): Promise<void> {
  switch (offer.kind) {
    case 'new_machine': signIn(setupItems(view, offer)); return
    case 'always_on': await shareSignIns(offer.machine_id, offer.machine_name, 'always_on'); return
    case 'terminal_login':
      if (offer.provider) signIn([{ id: `${offer.machine_id}:${offer.provider}:default`, machineId: offer.machine_id, machine: offer.machine_name, kind: offer.provider, method: 'sign_in', instance: 'default' }])
      return
    case 'migration_clash': {
      const clash = offer.clash
      if (answer === 'change' && clash) {
        try { await change((shared) => ({ ...shared, defaults: { ...shared.defaults, [clash.kind]: clash.was } })) } catch (error) { toastProblem(error, { action: 'change the default account' }); return }
      }
      await answerOffer(offer, 'never')
      return
    }
  }
}
