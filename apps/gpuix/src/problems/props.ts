// From the words to the screen: `describeProblem` says what happened and which actions fix it; this turns that view into the props of
// `ProblemState`, `ProblemRow` and `toast.problem`, with the look that goes with its kind and the buttons the action table can run here.
//
//   <ProblemState {...problemProps(describeProblem(error, { action: 'load pull requests' }), { retry: refresh, projectId })} />
import type { ProblemKind } from '../../../../packages/kybern-client/src/types.ts'
import type { ProblemView } from '../../../../packages/kybern-client/src/problems.ts'
import type { IconName } from '../icons.tsx'
import type { ProblemProps, ProblemTone } from '../kit/Problem.tsx'
import { resolveAction, type ActionContext } from './actions.ts'

/** The tone and glyph a kind of problem wears. */
export function problemLook(kind: ProblemKind): { tone: ProblemTone; icon: IconName } {
  switch (kind) {
    case 'tool_missing': return { tone: 'info', icon: 'console' }
    case 'update_needed': return { tone: 'info', icon: 'download' }
    case 'signed_out':
    case 'permission': return { tone: 'warning', icon: 'lock' }
    case 'conflict':
    case 'invalid_input': return { tone: 'warning', icon: 'alert' }
    case 'offline': return { tone: 'neutral', icon: 'offline' }
    case 'not_found': return { tone: 'neutral', icon: 'alert' }
    default: return { tone: 'danger', icon: 'alert' }
  }
}

/** Copy is already behind the details disclosure, so a "Copy details" action beside it would say the same thing twice. */
const isCopy = (id: string | undefined) => id === 'copy_detail' || id === 'copy_details'

/**
 * `ProblemProps` for `view`: its title, one sentence and technical text, the look of its kind, and a button for each action the table can
 * run with `context` (an action it cannot run is left out, and the second one then leads).
 */
export function problemProps(view: ProblemView, context: ActionContext = {}, testId?: string): ProblemProps {
  const withDetail = { detail: view.detail, ...context }
  const buttons = [view.action, view.secondary]
    .filter((action) => !(view.detail && isCopy(action?.id)))
    .map((action) => resolveAction(action, withDetail))
    .filter((button): button is NonNullable<typeof button> => button !== null)
  return { ...problemLook(view.kind), title: view.title, body: view.body, primary: buttons[0], secondary: buttons[1], detail: view.detail || undefined, ...(testId ? { testId } : {}) }
}
