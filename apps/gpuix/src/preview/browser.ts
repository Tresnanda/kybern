import { openTarget } from '../platform/os.ts'
import type { DaemonPage } from '../../../../packages/kybern-client/src/client.ts'
/** Resolve only after the system accepts the URL; callers can show a useful failure. */
export function launchBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Use an HTTP or HTTPS address.'))
  return openTarget(url).catch(() => { throw new Error('Could not open the browser. Try opening the address again.') })
}

/** How long a ticket page opened in the browser keeps its relay: the daemon drops an unused ticket after a minute. */
const PAGE_MS = 60_000
/** Open a ticket page (`KybernClient.openPage`) in the browser. Another machine's page keeps its relay long enough to load. */
export async function launchPage(page: DaemonPage, suffix = ''): Promise<void> {
  try { await launchBrowser(page.url + suffix) } catch (error) { page.close(); throw error }
  setTimeout(page.close, PAGE_MS).unref?.()
}
