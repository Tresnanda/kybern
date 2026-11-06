// A command or background job that failed, as a toast: the plain headline, one sentence, the fix as the action and "Copy" for the technical
// text. For a page that failed to load use `ProblemState` instead.
import type { ProblemContext } from '../../../../packages/kybern-client/src/problems.ts'
import { writeClipboardText } from '../platform/os.ts'
import { toast } from '../shell/toasts.tsx'
import type { ActionContext } from './actions.ts'
import { describe } from './describe.ts'
import { problemProps } from './props.ts'

/** Toast `error` as a problem: `context.action` is what was being done ("start the thread"). Returns the toast's id. */
export function toastProblem(error: unknown, context: ProblemContext & ActionContext & { id?: string }): string {
  const view = describe(error, context)
  const props = problemProps(view, context)
  const detail = view.detail
  return toast.problem(view.title, {
    id: context.id,
    tone: props.tone,
    icon: props.icon,
    description: view.body,
    action: props.primary,
    // The first button is the fix; the second is "Check again" or "Use another account", which a toast leaves to the page. Copy is always there.
    secondary: detail ? { label: 'Copy', onClick: () => { void writeClipboardText(detail).catch(() => {}) } } : undefined,
  })
}
