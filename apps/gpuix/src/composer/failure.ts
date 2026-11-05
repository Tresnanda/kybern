// A message that did not go, as the one line the "Not sent" row and the composer show: what happened, what to do, and that the text is kept.
// `PendingSend.error` and `NewChat.error` hold this line, whichever path (a direct send, a first message, the outbox) failed it.
import { problemLine } from '../problems/describe.ts'

const SAVED = 'Your message is saved.'

/** The line for `error` (an `Error`, an RPC error, or the text an outbox item recorded). */
export function sendFailure(error: unknown): string {
  return `${problemLine(error, { action: 'send your message' })} ${SAVED}`
}

/** `text` as a send failure: left alone when `sendFailure` already made it, else described as the text of an error. */
export function asSendFailure(text: string): string {
  return text.endsWith(SAVED) ? text : sendFailure(new Error(text))
}
