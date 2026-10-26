// Copy and decisions for visuals where the page cannot run in Kybern (no embedded web view, `webHost.available` false).
// The daemon-drawn picture still shows; the page opens in the browser; a question is answered in words. Pure, so tests
// pass `embedded` instead of reading the platform.
import { answerHint, answerTitle, type AnswerKind } from '../../../../packages/kybern-client/src/visualAnswer.ts'

export const VISUAL_NO_WEB_VIEW = "Interactive visuals can't run inside Kybern on this platform yet. Open the visual in your browser instead."

/** What a visual's controls do: `live` goes interactive in place; `static` shows the picture and offers the browser. */
export const visualMode = (embedded: boolean): 'live' | 'static' => embedded ? 'live' : 'static'

export const STATIC_VISUAL = {
  openBrowser: 'Open in browser',
  opening: 'Opening…',
  /** Under the picture in the full-screen viewer and tabs. */
  hint: "This visual's controls run in a web view, which isn't available on this platform yet. Open it in your browser to try them.",
  openFailed: "Couldn't open the visual",
  openFailedHint: 'Check your default browser, then try again.',
} as const

/** The answer bar's words: with the page running, choose in it; without, reply in words (the browser page cannot answer). */
export function answerBarCopy(embedded: boolean, kind: AnswerKind, agent: string, draft: string | null) {
  if (embedded) return { title: answerTitle(kind, agent), hint: answerHint(kind, draft), replyLabel: null as string | null }
  return {
    title: answerTitle(kind, agent),
    hint: "Choosing in the page isn't available on this platform yet. Reply in your own words, or skip.",
    replyLabel: 'Reply in your own words',
  }
}
/** Above the composer while the waiting figure is off screen. */
export const answerStubHint = (embedded: boolean, embeddedHint: string) => embedded ? embeddedHint : 'Type a reply below to answer in words, or skip.'
