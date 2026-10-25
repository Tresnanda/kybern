// The dock's words while a page lives in the browser instead of an embedded view (`webHost.available` false).
import { WEB_VIEW_MISSING } from '../native/webview-support.ts'

export function browserOnlyCopy(opened: boolean, error: string | null, host: string): { title: string; body: string } {
  if (error) return { title: "Couldn't open your browser", body: `Open ${host} again, or copy its address and paste it into a browser.` }
  if (opened) return { title: 'Opened in your browser', body: `${host} runs in your default browser. ${WEB_VIEW_MISSING}` }
  return { title: 'Opening in your browser…', body: `${host} runs in your default browser. ${WEB_VIEW_MISSING}` }
}
