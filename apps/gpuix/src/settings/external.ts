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
