import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import nodePath from 'node:path'
import { openTarget, pickFolderDialog, revealPath } from '../platform/os.ts'

/**
 * Open a web address in the default browser (`openExternal` in `lib/tauri.ts`).
 * Only http(s) is allowed. Automation sets `KYBERN_OPEN_URL_LOG` to record the
 * address in a file instead of launching a browser.
 */
export function openExternal(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let url: URL
    try { url = new URL(address) } catch { return reject(new Error('Unsupported address')) }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return reject(new Error('Unsupported address'))
    const log = process.env.KYBERN_OPEN_URL_LOG
    if (log) { appendFileSync(log, `${url.toString()}\n`); return resolve() }
    openTarget(url.toString()).then(resolve, reject)
  })
}

/** Ask for an existing folder with the system picker (`pickFolder` in `lib/tauri.ts`); null when canceled. */
export function pickFolder(): Promise<string | null> {
  return pickFolderDialog().catch(async (error) => {
    // A missing picker tool is the one failure worth a sentence; a canceled dialog is just null.
    const { toast } = await import('../shell/toasts.tsx')
    toast.error('Unable to choose a folder', { description: error instanceof Error ? error.message : String(error) })
    return null
  })
}

/**
 * Open a System Settings pane from a request card (`x-apple.systempreferences:…`). Only that scheme is allowed, so a daemon-sent
 * link can never launch anything else. `KYBERN_OPEN_URL_LOG` records it instead, as for `openExternal`.
 */
export function openSystemSettings(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The pane belongs to macOS: a client on Windows or Linux has nothing to open (the agent's Mac does).
    if (process.platform !== 'darwin') return reject(new Error('System Settings exists on macOS only'))
    if (!/^x-apple\.systempreferences:[\w.\-]+(\?[\w.=&\-]*)?$/.test(address)) return reject(new Error('Unsupported address'))
    const log = process.env.KYBERN_OPEN_URL_LOG
    if (log) { appendFileSync(log, `${address}\n`); return resolve() }
    execFile('open', [address], (error) => (error ? reject(error) : resolve()))
  })
}

/** The sentence for a System Settings pane that did not open. Off macOS the pane is on the Mac running the agent, not here. */
export function systemSettingsFailure(pane: string, then: string): string {
  return process.platform === 'darwin'
    ? `Unable to open System Settings. Open ${pane} yourself${then}.`
    : `System Settings is on the Mac that runs this agent, not on this computer. Open ${pane} there${then}.`
}

/** Show a file in the file manager, selected (`open -R` on macOS), so it can be dragged into a System Settings list. */
export function revealInFinder(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!nodePath.isAbsolute(path)) return reject(new Error('Unsupported path'))
    const log = process.env.KYBERN_OPEN_URL_LOG
    if (log) { appendFileSync(log, `reveal:${path}\n`); return resolve() }
    revealPath(path).then(resolve, reject)
  })
}
