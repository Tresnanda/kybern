// The same generic-password service/account as the Tauri client (its `keyring` crate), on each platform's own store. Secrets
// never enter environments.json, command arguments, logs, or UI persistence.
//
// - macOS: the Keychain, through Security.framework, in process (unchanged).
// - Windows and Linux: the bundled `kybern credentials get|set|delete` command (crates/kybern-cli/src/credentials.rs), which
//   is the `keyring` crate the Tauri client uses, so both clients share one set of entries on Credential Manager and the
//   Secret Service. It runs asynchronously (an unlock prompt can take a while), the secret travels on stdin and stdout, and
//   each token is cached in memory per id after its first read or write.
// - A locked or dismissed keyring is an error: never a reason to write the token to a plain file. Only a machine with no
//   Secret Service or D-Bus at all (the command exits 5) stores it in a 0600 file under the GPUIX data folder instead.
// - A scratch run (`KYBERN_GPUIX_CREDENTIALS_DIR`) uses only that folder, on every platform.
import { dlopen, FFIType as F, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gpuixLocalDir, osContext, osName, pathFor, type OsContext } from '../platform/os.ts'
import { bundledCommand } from '../shell/daemon.ts'

const DESKTOP_SERVICE = 'dev.kybern.desktop.environments'
/** Checks exercise the real store under a scratch service (`KYBERN_GPUIX_KEYCHAIN_SERVICE=kybern-gpuix-test-…`, with a scratch client config), never the desktop's items. */
function serviceName(ctx: OsContext = osContext()): string {
  const scratch = ctx.env.KYBERN_GPUIX_KEYCHAIN_SERVICE
  if (!scratch) return DESKTOP_SERVICE
  if (!ctx.env.KYBERN_CLIENT_CONFIG_DIR || !/^kybern-gpuix-test-[\w-]+$/.test(scratch)) throw new Error('A scratch Keychain service needs KYBERN_CLIENT_CONFIG_DIR and a kybern-gpuix-test-… name')
  return scratch
}
const service = (ctx: OsContext = osContext()) => Buffer.from(serviceName(ctx))

export type CredentialBackend = 'scratch-file' | 'keychain' | 'keyring' | 'file'
/** The stores to try, best first. A write goes to the first that works; a read takes the first that has the token; a remove clears all. */
export function credentialBackends(ctx: OsContext = osContext()): CredentialBackend[] {
  if (ctx.env.KYBERN_GPUIX_CREDENTIALS_DIR) return ['scratch-file']
  switch (osName(ctx.platform)) {
    case 'macos': return ['keychain']
    case 'windows': return ['keyring', 'file']
    case 'linux': return ['keyring', 'file']
  }
}
/** Where a token lives when no credential store runs at all: GPUIX's per-machine data folder (`%LOCALAPPDATA%` on Windows), readable by the user alone. */
export const credentialFile = (id: string, ctx: OsContext = osContext()) => pathFor(ctx.platform).join(ctx.env.KYBERN_GPUIX_CREDENTIALS_DIR ?? pathFor(ctx.platform).join(gpuixLocalDir(ctx), 'credentials'), `${encodeURIComponent(id)}.token`)
function scratchFile(id: string) {
  if (!process.env.KYBERN_CLIENT_CONFIG_DIR) throw new Error('Isolated credentials require KYBERN_CLIENT_CONFIG_DIR')
  return credentialFile(id)
}
export function readFileToken(file: string): string | null {
  try { return readFileSync(file, 'utf8').trim() || null } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
export function writeFileToken(file: string, token: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, token, { mode: 0o600 }); renameSync(temp, file)
}
export function removeFileToken(file: string) {
  try { unlinkSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}

// ---- macOS: Keychain ----

const MISSING = -25300
function framework() {
  const security = dlopen('/System/Library/Frameworks/Security.framework/Security', {
    SecKeychainFindGenericPassword: { args: [F.ptr, F.u32, F.ptr, F.u32, F.ptr, F.ptr, F.ptr, F.ptr], returns: F.i32 },
    SecKeychainAddGenericPassword: { args: [F.ptr, F.u32, F.ptr, F.u32, F.ptr, F.u32, F.ptr, F.ptr], returns: F.i32 },
    SecKeychainItemModifyAttributesAndData: { args: [F.ptr, F.ptr, F.u32, F.ptr], returns: F.i32 },
    SecKeychainItemFreeContent: { args: [F.ptr, F.ptr], returns: F.i32 },
    SecKeychainItemDelete: { args: [F.ptr], returns: F.i32 },
  })
  const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', { CFRelease: { args: [F.ptr], returns: F.void } })
  return { ...security.symbols, ...cf.symbols }
}
let native: ReturnType<typeof framework> | undefined
function api() {
  if (process.platform !== 'darwin') throw new Error('The Keychain exists on macOS only')
  return native ??= framework()
}
function checked(status: number) {
  if (status) throw new Error(`Unlock the system credential store or pair this environment again (Keychain ${status})`)
}
function find(id: string, secret: boolean) {
  const SERVICE = service(), account = Buffer.from(id)
  const length = new Uint32Array(1)
  const data = new BigUint64Array(1)
  const item = new BigUint64Array(1)
  const status = api().SecKeychainFindGenericPassword(null, SERVICE.length, ptr(SERVICE), account.length, ptr(account), secret ? ptr(length) : null, secret ? ptr(data) : null, ptr(item))
  return { status, length: length[0]!, data: read.ptr(ptr(data)) as Pointer, item: read.ptr(ptr(item)) as Pointer }
}

// ---- Windows and Linux: the bundled `kybern credentials` command ----

/** Exit codes of `kybern credentials` (crates/kybern-cli/src/credentials.rs). */
export const KEYRING_EXIT = { notFound: 3, locked: 4, unavailable: 5 } as const
export interface KeyringRun { status: number | null; stdout: string; stderr: string }
/** Runs `kybern credentials …`. `null` when the command is not installed. Replaced in tests. */
export type KeyringRunner = (args: string[], input?: string) => Promise<KeyringRun | null>

/** `kybern credentials <op>` arguments. The secret is never one of them: `set` reads it from stdin, `get` prints it on stdout. */
export function keyringArgs(op: 'get' | 'set' | 'delete', id: string, serviceId: string): string[] {
  return ['credentials', op, '--service', serviceId, '--account', id]
}
const KEYRING_TIMEOUT_MS = 120_000
const runKeyringCommand: KeyringRunner = (args, input) => new Promise((resolve, reject) => {
  const command = bundledCommand('kybern')
  if (!command) return resolve(null)
  let child
  try { child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }) } catch (error) { return reject(error) }
  let stdout = '', stderr = '', done = false
  const finish = (run: KeyringRun | Error) => { if (done) return; done = true; clearTimeout(timer); run instanceof Error ? reject(run) : resolve(run) }
  // A dismissed unlock prompt can leave the command waiting; stop it rather than hang the connection.
  const timer = setTimeout(() => { child.kill(); finish(new Error('The system credential store did not answer. Unlock your keyring, then try again.')) }, KEYRING_TIMEOUT_MS)
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  child.on('error', error => finish(error))
  child.on('close', status => finish({ status, stdout, stderr }))
  if (input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(input) }
})
let keyringRunner: KeyringRunner = runKeyringCommand
/** Replace the command runner (tests); returns the previous one. */
export function setKeyringRunner(runner: KeyringRunner | null): KeyringRunner {
  const previous = keyringRunner
  keyringRunner = runner ?? runKeyringCommand
  return previous
}

// ---- one store at a time ----

type Outcome = { kind: 'ok'; value?: string } | { kind: 'missing'; detail?: string } | { kind: 'unavailable'; detail?: string }
interface Store {
  read(id: string, ctx: OsContext): Promise<Outcome>
  write(id: string, token: string, ctx: OsContext): Promise<Outcome>
  remove(id: string, ctx: OsContext): Promise<Outcome>
}
export const UNLOCK_KEYRING = 'Unlock your keyring, then try again.'
const UNLOCK = 'Unlock the system credential store or pair this environment again'
const ok = (value?: string): Outcome => ({ kind: 'ok', value })

const keychain: Store = {
  async read(id) {
    const found = find(id, true)
    if (found.status === MISSING) return { kind: 'missing', detail: `Keychain ${found.status}` }
    checked(found.status)
    try { return ok(Buffer.from(toArrayBuffer(found.data, 0, found.length)).toString('utf8')) }
    finally { api().SecKeychainItemFreeContent(null, found.data); api().CFRelease(found.item) }
  },
  async write(id, token) {
    const found = find(id, false)
    const password = Buffer.from(token)
    if (found.status === MISSING) {
      const SERVICE = service(), account = Buffer.from(id)
      checked(api().SecKeychainAddGenericPassword(null, SERVICE.length, ptr(SERVICE), account.length, ptr(account), password.length, ptr(password), null))
    } else {
      checked(found.status)
      try { checked(api().SecKeychainItemModifyAttributesAndData(found.item, null, password.length, ptr(password))) }
      finally { api().CFRelease(found.item) }
    }
    return ok()
  },
  async remove(id) {
    const found = find(id, false)
    if (found.status === MISSING) return { kind: 'missing' }
    checked(found.status)
    try { checked(api().SecKeychainItemDelete(found.item)) } finally { api().CFRelease(found.item) }
    return ok()
  },
}

/** What a `kybern credentials` run means: an outcome the stores can fall back on, or an error the user must act on (never echoes the input). */
export function keyringOutcome(run: KeyringRun | null, op: 'get' | 'set' | 'delete'): Outcome {
  if (!run) throw new Error('This install of Kybern is missing its kybern command, which holds your saved device tokens. Reinstall Kybern, then try again.')
  if (run.status === 0) return ok(op === 'get' ? run.stdout : undefined)
  if (run.status === KEYRING_EXIT.notFound) return { kind: 'missing' }
  if (run.status === KEYRING_EXIT.unavailable) return { kind: 'unavailable', detail: run.stderr.trim().slice(0, 160) }
  if (run.status === KEYRING_EXIT.locked) throw new Error(UNLOCK_KEYRING)
  throw new Error(`${UNLOCK} (${run.stderr.trim().split('\n')[0]?.slice(0, 160) || `kybern credentials ${run.status ?? 'did not finish'}`})`)
}
const keyring: Store = {
  read: async (id, ctx) => keyringOutcome(await keyringRunner(keyringArgs('get', id, serviceName(ctx))), 'get'),
  write: async (id, token, ctx) => keyringOutcome(await keyringRunner(keyringArgs('set', id, serviceName(ctx)), token), 'set'),
  remove: async (id, ctx) => keyringOutcome(await keyringRunner(keyringArgs('delete', id, serviceName(ctx))), 'delete'),
}

const fileStore: Store = {
  read: async (id, ctx) => { const token = readFileToken(credentialFile(id, ctx)); return token ? ok(token) : { kind: 'missing' } },
  write: async (id, token, ctx) => { writeFileToken(credentialFile(id, ctx), token); return ok() },
  remove: async (id, ctx) => { removeFileToken(credentialFile(id, ctx)); return ok() },
}
const scratchStore: Store = {
  read: async (id) => { const file = scratchFile(id); return ok(readFileSync(file, 'utf8').trim()) },
  write: async (id, token) => { writeFileToken(scratchFile(id), token); return ok() },
  remove: async (id) => { removeFileToken(scratchFile(id)); return ok() },
}
const STORES: Record<CredentialBackend, Store> = { 'scratch-file': scratchStore, keychain, keyring, file: fileStore }

// Off macOS each read is a process spawn, so a token read or written once stays in memory for the life of the process.
const cache = new Map<string, string>()
/** Forget every cached token (tests). */
export function clearCredentialCache() { cache.clear() }

let warnedFile = false
/** The credential store of `ctx` (this machine by default). `readCredential` and the others are this, bound to the real process. */
export function credentialStore(ctx: OsContext = osContext()) {
  const cached = osName(ctx.platform) !== 'macos'
  return {
    async read(id: string): Promise<string> {
      const hit = cached ? cache.get(id) : undefined
      if (hit !== undefined) return hit
      let detail: string | undefined
      for (const backend of credentialBackends(ctx)) {
        const result = await STORES[backend].read(id, ctx)
        if (result.kind === 'ok') { if (cached) cache.set(id, result.value!); return result.value! }
        detail ??= result.detail
      }
      throw new Error(detail ? `${UNLOCK} (${detail})` : UNLOCK)
    },
    async write(id: string, token: string): Promise<void> {
      const backends = credentialBackends(ctx)
      let detail: string | undefined
      for (const backend of backends) {
        const result = await STORES[backend].write(id, token, ctx)
        if (result.kind !== 'ok') { detail ??= result.detail; continue }
        if (backend === 'file' && backends.length > 1 && !warnedFile) { warnedFile = true; console.warn(`[credentials] no system credential store is running${detail ? ` (${detail})` : ''}; the token is kept in a private file in GPUIX's data folder`) }
        // A token saved to the file store while no keyring ran would otherwise outlive the one now in the keyring.
        if (backend !== 'file' && backend !== 'scratch-file' && backends.includes('file')) removeFileToken(credentialFile(id, ctx))
        if (cached) cache.set(id, token)
        return
      }
      throw new Error(detail ? `${UNLOCK} (${detail})` : UNLOCK)
    },
    async remove(id: string): Promise<void> {
      cache.delete(id)
      for (const backend of credentialBackends(ctx)) await STORES[backend].remove(id, ctx)
    },
  }
}
export const readCredential = (id: string): Promise<string> => credentialStore().read(id)
export const writeCredential = (id: string, token: string): Promise<void> => credentialStore().write(id, token)
export const removeCredential = (id: string): Promise<void> => credentialStore().remove(id)
