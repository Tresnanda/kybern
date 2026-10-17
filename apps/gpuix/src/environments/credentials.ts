// The same generic-password service/account as the Tauri client. Secrets never
// enter environments.json, command arguments, logs, or UI persistence.
import { dlopen, FFIType as F, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DESKTOP_SERVICE = 'dev.kybern.desktop.environments'
/** Checks exercise the real Keychain under a scratch service (`KYBERN_GPUIX_KEYCHAIN_SERVICE=kybern-gpuix-test-…`, with a scratch client config), never the desktop's items. */
function service() {
  const scratch = process.env.KYBERN_GPUIX_KEYCHAIN_SERVICE
  if (!scratch) return Buffer.from(DESKTOP_SERVICE)
  if (!process.env.KYBERN_CLIENT_CONFIG_DIR || !/^kybern-gpuix-test-[\w-]+$/.test(scratch)) throw new Error('A scratch Keychain service needs KYBERN_CLIENT_CONFIG_DIR and a kybern-gpuix-test-… name')
  return Buffer.from(scratch)
}
const MISSING = -25300
function isolatedFile(id: string) {
  const dir = process.env.KYBERN_GPUIX_CREDENTIALS_DIR
  if (!dir) return null
  if (!process.env.KYBERN_CLIENT_CONFIG_DIR) throw new Error('Isolated credentials require KYBERN_CLIENT_CONFIG_DIR')
  return path.join(dir, `${encodeURIComponent(id)}.token`)
}
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
  if (process.platform !== 'darwin') throw new Error('The system credential store is currently available on macOS only')
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
export function readCredential(id: string): string {
  const file = isolatedFile(id)
  if (file) return readFileSync(file, 'utf8').trim()
  const found = find(id, true)
  checked(found.status)
  try { return Buffer.from(toArrayBuffer(found.data, 0, found.length)).toString('utf8') }
  finally { api().SecKeychainItemFreeContent(null, found.data); api().CFRelease(found.item) }
}
export function writeCredential(id: string, token: string) {
  const file = isolatedFile(id)
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, token, { mode: 0o600 }); renameSync(temp, file)
    return
  }
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
}
export function removeCredential(id: string) {
  const file = isolatedFile(id)
  if (file) { try { unlinkSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }; return }
  const found = find(id, false)
  if (found.status === MISSING) return
  checked(found.status)
  try { checked(api().SecKeychainItemDelete(found.item)) } finally { api().CFRelease(found.item) }
}
