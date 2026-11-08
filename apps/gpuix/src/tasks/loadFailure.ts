// What the All tasks page says when its first load failed (#299). Plain words only: the raw error never reaches the
// page, and "busy" is told apart from "can't reach" because the fix differs.
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'

export interface LoadFailureCopy {
  title: string
  description: string
}

const TITLE = 'Couldn’t load tasks'

export function loadFailureCopy(error: unknown): LoadFailureCopy {
  const view = describeProblem(error, { action: 'load tasks' })
  if (view.kind === 'conflict' && view.subject === 'busy') {
    return { title: TITLE, description: 'Kybern was busy with other requests. Try again in a moment.' }
  }
  if (view.kind === 'offline') {
    return { title: TITLE, description: `Kybern can’t reach ${view.subject ?? 'this computer'}. Check that it’s on and connected, then try again.` }
  }
  if (view.kind === 'internal') return { title: TITLE, description: 'Something went wrong. Try again in a moment.' }
  return { title: TITLE, description: view.body }
}
