// What the account surfaces do. Each action goes to the machine it targets through that machine's own client; the
// shared choices (default, name, "Only when I choose", offer answers) go through `adapter.ts`.
import type { AccountSummary, DaemonUpdate, MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { showDialog } from '../dialogs/store.ts'
import { toastProblem } from '../problems/toast.ts'
import { setSettings } from '../settings/store.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient } from '../state.ts'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { refreshAccounts } from '../usage/accounts.ts'
import { setSharing, signOutTerminalLogin, supportsShared, writeShared } from './adapter.ts'
import { TERMINAL_SIGN_IN_KINDS, type Offer } from './offers.ts'
import { existingFor, needsAccountsUpdate, planOnMachine, planSetup, signInNeedsUpdate, type SignInItem } from './queue.ts'
import { adoptSettings, clientOf, computerId, infoOf, lendableOn, prefsChanged, primaryId, readMachine, refreshAllAccounts, type UnifiedView } from './store.ts'
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

/** Which machines take a new shared default: those with the account that share the choice, now or when they are back.
 *  A machine without the account, or too old to share, keeps its own. */
export function defaultTakers(view: Pick<UnifiedView, 'machines'>, account: Pick<UnifiedAccount, 'presences'>): { took: string[]; later: string[] } {
  const took: string[] = []
  const later: string[] = []
  for (const standing of standings(account)) {
    const features = view.machines.find((m) => m.machineId === standing.machineId)?.features
    if (!standing.online) later.push(standing.machine)
    else if (supportsShared(features)) took.push(standing.machine)
  }
  return { took, later }
}

/** The toast after "Make default": it names only the machines that took it, unless that is all of them. */
export function defaultMessage(account: string, agent: string, took: readonly string[], rest: { later?: readonly string[]; kept?: readonly string[] }, machines: number): string {
  const first = !took.length
    ? `${account} is saved as the default for ${agent}`
    : `${account} is now the default for ${agent}${took.length === machines ? '' : ` on ${list(took)}`}`
  const one = (names: readonly string[]) => names.length === 1
  if (rest.later?.length) return `${first}. ${list(rest.later)} ${one(rest.later) ? 'follows when it’s' : 'follow when they’re'} back.`
  if (rest.kept?.length) return `${first}. ${list(rest.kept)} ${one(rest.kept) ? 'keeps its default until it’s' : 'keep their default until they’re'} back.`
  return first
}

/** One default per agent, on every machine that has the account. */
export async function makeDefault(view: UnifiedView, account: UnifiedAccount): Promise<boolean> {
  try {
    const away: string[] = []
    let took: string[] = []
    let later: string[] = []
    if (view.supportsShared && account.key) {
      await change((shared) => ({ ...shared, defaults: { ...shared.defaults, [account.kind]: account.key! } }))
      ;({ took, later } = defaultTakers(view, account))
    } else {
      // A daemon that can't share the choice: set it on each machine that has the account.
      for (const standing of standings(account)) {
        if (!standing.online) { away.push(standing.machine); continue }
        const named = standing.presences.find((p) => !p.terminal)
        const client = clientOf(standing.machineId)
        const settings = await client.call('settings.get', {})
        const current = settings.providers[account.kind] ?? { env: {} }
        const saved = await client.call('settings.update', { settings: { ...settings, providers: { ...settings.providers, [account.kind]: { ...current, default_account: named?.instance ?? null } } }, base: settings })
        if (standing.machineId === primaryId()) setSettings(saved)
        await reread(standing.machineId)
        took.push(standing.machine)
      }
    }
    await refreshAccounts()
    toast.success(defaultMessage(account.name, PROVIDER_NAMES[account.kind] ?? account.kind, took, { later, kept: away }, view.machines.length))
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

/** The accounts a borrow made and hasn't finished with, by machine, agent and shared sign-in. One that couldn't be taken
 *  away again (the connection dropped) is what the next try uses. */
const unfinished = new Map<string, string>()
type Borrowing = Pick<SignInItem, 'machineId' | 'kind' | 'lender'>
const slotOf = (item: Borrowing) => `${item.machineId}:${item.kind}:${item.lender?.account}`

/** An account made for a borrow that never got one: nobody signed in, nothing borrowed, nothing chosen for it. */
const isLeftover = (a: AccountSummary, kind: ProviderKind, name: string) =>
  a.provider.kind === kind && a.provider.instance !== 'default' && a.name === name && a.managed && !a.broker && a.status !== 'signed_in'
  && !a.identity?.email && !a.is_default && a.projects.length === 0

/** Take away the account a borrow made and didn't finish. It stays remembered while the machine can't be reached. */
export async function discardBorrow(item: Borrowing, connect = clientOf): Promise<void> {
  const slot = slotOf(item)
  const instance = unfinished.get(slot)
  if (!instance) return
  try {
    await connect(item.machineId).call('providers.accounts.remove', { kind: item.kind, instance })
    unfinished.delete(slot)
  } catch { /* The next try uses it. */ }
}

/**
 * Borrow a shared sign-in into a local account. It uses the machine's account of that email, one that already borrows
 * this sign-in or an empty one an earlier try left, and makes one only when there is none. A borrow that fails, or is
 * cancelled before it is bound, takes the account it made away again.
 */
export async function borrow(view: UnifiedView, item: SignInItem, connect = clientOf, cancelled?: AbortSignal): Promise<void> {
  const lender = item.lender
  if (!lender) throw new Error('There is no sign-in to borrow')
  const machine = view.machines.find((m) => m.machineId === item.machineId)
  // The sheet asks for the update before it gets here; nothing is made on a machine that would refuse to bind it.
  if (signInNeedsUpdate(machine, computerId())) {
    throw Object.assign(new Error(`Update Kybern on ${item.machine}`), { data: { problem: { kind: 'update_needed', hint: `Update Kybern on ${item.machine}, then try again.` } } })
  }
  const client = connect(item.machineId)
  const slot = slotOf(item)
  const name = item.name ?? item.email ?? lender.account
  let instance = item.instance && item.instance !== 'default' ? item.instance : existingFor(machine?.accounts ?? [], item.kind, item.email)?.provider.instance
  if (!instance) {
    // What the machine has now, not what was read when the sheet opened.
    const accounts = (await client.call('providers.accounts.list', { kind: item.kind })).accounts
    const mine = accounts.filter((a) => a.provider.kind === item.kind && a.provider.instance !== 'default')
    const sameEmail = (a: AccountSummary) => !a.identity?.email || !item.email || a.identity.email.toLowerCase() === item.email.toLowerCase()
    instance = (mine.find((a) => a.provider.instance === unfinished.get(slot))
      ?? existingFor(mine, item.kind, item.email)
      ?? mine.find((a) => a.broker?.broker_account === lender.account && sameEmail(a))
      ?? mine.find((a) => isLeftover(a, item.kind, name)))?.provider.instance
    if (!instance) {
      cancelled?.throwIfAborted()
      try {
        instance = (await client.call('providers.accounts.create', { kind: item.kind, name })).instance
      } catch (error) {
        // The answer can get lost after the account was made: take away what appeared.
        const before = new Set(accounts.map((a) => a.provider.instance))
        const after = await client.call('providers.accounts.list', { kind: item.kind }).then((r) => r.accounts, () => [])
        const appeared = after.find((a) => !before.has(a.provider.instance) && isLeftover(a, item.kind, name))
        if (appeared) {
          unfinished.set(slot, appeared.provider.instance)
          await discardBorrow(item, connect)
        }
        throw error
      }
      unfinished.set(slot, instance)
    }
  }
  try {
    cancelled?.throwIfAborted()
    await client.call('login.broker.bind', { provider: item.kind, instance, broker_account: lender.account })
  } catch (error) {
    // The refusal is what the person needs to see, even if tidying up fails too.
    if (unfinished.get(slot) === instance) await discardBorrow(item, connect)
    throw error
  }
  // Bound. An account an earlier try made that this one didn't use is not needed any more.
  if (unfinished.get(slot) === instance) unfinished.delete(slot)
  else await discardBorrow(item, connect)
  // Borrowed: a read that fails afterwards doesn't undo that.
  await reread(item.machineId).catch(() => {})
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

/** Sign the terminal login in on each of these machines, one after another. */
export function signInTerminals(kind: ProviderKind, machines: readonly { machineId: MachineId; machine: string }[]) {
  const items = machines.map(({ machineId, machine }): SignInItem => ({ id: `${machineId}:${kind}:default`, machineId, machine, kind, method: 'sign_in', ...(kind === 'antigravity' ? { ownLogin: true } : { instance: 'default' }) }))
  signIn(items)
}

/** "Sign in here instead": stop borrowing, then sign this machine in itself. */
export async function signInInstead(account: UnifiedAccount, machine: { machineId: MachineId; name: string }) {
  const presence = account.presences.find((p) => p.machineId === machine.machineId && p.lender)
  if (!presence) return signInOn(account, machine)
  // A machine that must update first can't be asked: the sheet says so, and stops the borrow once it has updated.
  if (needsAccountsUpdate(infoOf(machine.machineId))) return signIn([{ ...planOnMachine(account, machine), instance: presence.instance }])
  try {
    await clientOf(machine.machineId).call('login.broker.bind', { provider: account.kind, instance: presence.instance, broker_account: null })
    await reread(machine.machineId)
    signIn([{ ...planOnMachine(account, machine), instance: presence.instance }])
  } catch (error) {
    toastProblem(error, { action: `sign ${account.name} in on ${machine.name}` })
  }
}

/** "Update" on a machine that must update before it takes sign-ins: the same action as Settings › Machines. */
export async function updateMachine(machineId: MachineId): Promise<DaemonUpdate> {
  const { retryMachineUpdate } = await import('../machines/network.ts')
  return retryMachineUpdate(machineId)
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
      // The card names the terminal login, so this is the one place besides Settings that signs it in.
      if (offer.provider) signInTerminals(offer.provider, [{ machineId: offer.machine_id, machine: offer.machine_name }])
      return
    case 'migration_clash': {
      const clash = offer.clash
      if (answer !== 'change' || !clash) return answerOffer(offer, 'never')
      // The new default and the answer in one write: the card is settled as the default changes.
      try {
        await change((shared) => ({ ...shared, defaults: { ...shared.defaults, [clash.kind]: clash.was }, offers: { ...shared.offers, [offer.id]: { state: 'never', fingerprint: offer.fingerprint } } }))
      } catch (error) { toastProblem(error, { action: 'change the default account' }) }
      return
    }
  }
}
