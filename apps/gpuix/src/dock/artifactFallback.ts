// An HTML artifact where no page can run in Kybern (no embedded web view): its source stays readable and the page opens in the browser.
import { WEB_VIEW_MISSING } from '../native/webview-support.ts'

export type ArtifactBrowserPhase = 'idle' | 'opening' | 'opened' | 'failed'

/** Title, body and button label of the state that replaces the artifact's frame. */
export function artifactBrowserCopy(phase: ArtifactBrowserPhase, title: string): { title: string; body: string; action: string } {
  switch (phase) {
    case 'opened': return { title: 'Opened in your browser', body: `${title} runs in your default browser. ${WEB_VIEW_MISSING}`, action: 'Open again' }
    case 'opening': return { title: 'Opening in your browser…', body: `${title} runs in your default browser.`, action: 'Open again' }
    case 'failed': return { title: "Couldn't open your browser", body: 'Check your default browser, then try again. The source is still here under Source.', action: 'Try again' }
    default: return { title: 'Open this artifact in your browser', body: `${title} is a web page. ${WEB_VIEW_MISSING}`, action: 'Open in browser' }
  }
}
