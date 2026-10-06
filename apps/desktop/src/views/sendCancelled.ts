/**
 * Throw this from `onSend` when the person backed out (a confirmation they dismissed):
 * the message stays as it is and nothing is reported.
 */
export class SendCancelled extends Error {
  readonly cancelled = true
  constructor() {
    super("Send canceled")
  }
}
