import { openTarget } from '../platform/os.ts'
/** Resolve only after the system accepts the URL; callers can show a useful failure. */
export function launchBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Use an HTTP or HTTPS address.'))
  return openTarget(url).catch(() => { throw new Error('Could not open the browser. Try opening the address again.') })
}
