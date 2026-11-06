// A failure as plain text, for the few places that have room for one line and not a card: a request card's hint line, a status string. Same
// words as `ProblemRow` (`describeProblem`: the headline, then the one sentence), so the two never disagree; the technical text goes to the
// console instead of the screen. Prefer `ProblemLine` or `toastProblem` where there is room for a button.
import { describeProblem, type ProblemContext } from '../../../../packages/kybern-client/src/problems.ts'

/** "Couldn't send your answer. Try again." for any caught `error`. */
export function problemSentence(error: unknown, context: ProblemContext): string {
  const view = describeProblem(error, context)
  if (view.detail) console.warn(`${view.title}: ${view.detail}`)
  // A hint line has no Details button to copy from.
  const body = view.body.replace(/\s*If it keeps happening, copy the details and report them\./, '').trim()
  return body ? `${view.title}. ${body}` : view.title
}
