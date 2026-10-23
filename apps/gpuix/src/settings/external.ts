import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'

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
    execFile('open', [url.toString()], (error) => (error ? reject(error) : resolve()))
  })
}

/** Ask for an existing folder with the system picker (`pickFolder` in `lib/tauri.ts`); null when canceled. */
export function pickFolder(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder")'], (error, stdout) => resolve(error ? null : stdout.trim().replace(/\/$/, '') || null))
  })
}

/**
 * Open a System Settings pane from a request card (`x-apple.systempreferences:…`). Only that scheme is allowed, so a daemon-sent
 * link can never launch anything else. `KYBERN_OPEN_URL_LOG` records it instead, as for `openExternal`.
 */
export function openSystemSettings(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!/^x-apple\.systempreferences:[\w.\-]+(\?[\w.=&\-]*)?$/.test(address)) return reject(new Error('Unsupported address'))
    const log = process.env.KYBERN_OPEN_URL_LOG
    if (log) { appendFileSync(log, `${address}\n`); return resolve() }
    execFile('open', [address], (error) => (error ? reject(error) : resolve()))
  })
}

/** Show a file in Finder, selected (`open -R`), so it can be dragged into a System Settings list. */
export function revealInFinder(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!path.startsWith('/')) return reject(new Error('Unsupported path'))
    const log = process.env.KYBERN_OPEN_URL_LOG
    if (log) { appendFileSync(log, `reveal:${path}\n`); return resolve() }
    execFile('open', ['-R', path], (error) => (error ? reject(error) : resolve()))
  })
}
