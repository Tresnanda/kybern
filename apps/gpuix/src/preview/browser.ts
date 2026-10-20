import { execFile } from 'node:child_process'
/** Resolve only after macOS accepts the URL; callers can show a useful failure. */
export function launchBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Use an HTTP or HTTPS address.'))
  return new Promise((resolve, reject) => execFile('open', [url], { timeout: 10000 }, error => error ? reject(new Error('Could not open the browser. Try opening the address again.')) : resolve()))
}
