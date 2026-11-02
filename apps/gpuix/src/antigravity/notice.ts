// The one-time notice before the first Antigravity sign-in on this device (ADE-111): Google says third-party use on a personal
// plan may get the account suspended. The acknowledgement is kept in the UI-state file, so it shows once per device.
import { showDialog } from '../dialogs/store.ts'
import { load, save } from '../shell/persist.ts'

const KEY = 'kybern.antigravity.signInNotice'

export const antigravityNoticeSeen = (): boolean => load<boolean>(KEY, false) === true
export const acknowledgeAntigravityNotice = () => save(KEY, true)

/** Run `proceed` now when the notice was already accepted, otherwise after the person chooses "Sign in anyway". */
export function requestAntigravitySignIn(proceed: () => void) {
  if (antigravityNoticeSeen()) proceed()
  else showDialog({ kind: 'antigravity-notice', proceed })
}
