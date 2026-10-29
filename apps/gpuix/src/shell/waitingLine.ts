// The line a toast or notification shows while an agent waits on the reader. Summoned cards ask for something (a choice in a
// visual, a pick, a sign-in, a password, a permission, a key, an answer); only a real approval says "Needs approval".
import { pickRequestInput } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { loginRequestInput, passwordPurpose, permissionPane, permissionRequestInput, promptRequestInput } from '../../../../packages/kybern-client/src/requestCards.ts'
import { secretRequestInput } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { provisionCardInput } from '../../../../packages/kybern-client/src/provision.ts'
import type { ApprovalRequest, PromptRequestInput } from '../../../../packages/kybern-client/src/types.ts'
import { isUserInput } from '../../../../packages/kybern-client/src/userInput.ts'
import { visualAnswerInput } from '../../../../packages/kybern-client/src/visualAnswer.ts'

/** What a command's prompt waits for, after "is waiting for". */
function promptWant(input: PromptRequestInput): string {
  switch (passwordPurpose(input)) {
    case 'sudo': return 'your Mac password'
    case 'ssh_passphrase': return 'your SSH key passphrase'
    case 'ssh_host_key': return `you to trust ${input.host ?? 'a server'}`
    case 'git_username':
    case 'git_password': return `you to sign in to ${input.host ?? 'the git server'}`
    case 'other': return 'an answer to a command’s prompt'
  }
}

/** `agent` is the harness's short name, capitalised ("Claude", "The agent"). */
export function waitingLine(approval: ApprovalRequest, agent: string): string {
  const visual = visualAnswerInput(approval)
  if (visual) return `${agent} is waiting for your choice in “${visual.title}”`
  const pick = pickRequestInput(approval)
  if (pick) return pick.prompt ? `${agent} is waiting for you to point: ${pick.prompt}` : `${agent} is waiting for you to point to something`
  const login = loginRequestInput(approval)
  if (login) return `${agent} is waiting for you to sign in to ${login.service}`
  const prompt = promptRequestInput(approval)
  if (prompt) return `${agent} is waiting for ${promptWant(prompt)}`
  const permission = permissionRequestInput(approval)
  if (permission) return `${agent} is waiting for you to let ${permission.app} ${permissionPane(permission.pane).verb}`
  const secret = secretRequestInput(approval)
  if (secret) return `${agent} is waiting for ${secret.label}`
  const provision = provisionCardInput(approval)
  if (provision) return `${agent} is waiting for you to add ${provision.plan.project_name} to ${provision.plan.target.name}`
  // `kybern_ask_user` (a question with a deadline) arrives as an approval of its own `AskUserQuestion`.
  if (isUserInput(approval)) return questionLine(approval, agent)
  return `Needs approval: ${approval.summary}`
}

/** A card that asks the reader for something rather than for permission to run a tool. */
export const isSummonedCard = (approval: ApprovalRequest) =>
  !!(visualAnswerInput(approval) || pickRequestInput(approval) || loginRequestInput(approval) || promptRequestInput(approval) || permissionRequestInput(approval) || secretRequestInput(approval) || provisionCardInput(approval))

/** A question (`user_input_requested`): the first question when there is one. */
export function questionLine(approval: ApprovalRequest, agent: string): string {
  // The question itself when the daemon sent it (Claude's summary is only the tool name, "AskUserQuestion"), first line, clipped.
  const asked = approval.questions?.[0]?.question.trim().split('\n')[0]?.trim()
  const summary = approval.summary.trim()
  const text = asked ? asked.length > 120 ? `${asked.slice(0, 119)}…` : asked
    : summary && summary !== approval.tool_name && summary !== 'Answer the agent\'s questions' ? summary : ''
  return text ? `${agent} is waiting for your answer: ${text}` : `${agent} is waiting for your answers`
}
