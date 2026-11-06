import type { IssueDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { getData } from '../../composer/store.ts'
import { openThread } from '../../nav/history.ts'
import { refreshLists } from '../../state.ts'
import { prClient } from '../client.ts'
import { issuePrompt, threadTitle } from './model.ts'

/**
 * Start a thread in the issue's project with the issue as its first message (title, number, link, description and the first
 * comments, bounded: `issuePrompt`), in the agent and permission mode the user's settings choose. Opens the thread.
 * `repoName` names the repository of a group project in the message.
 */
export async function startIssueThread(projectId: string, detail: IssueDetailResult, repoName?: string): Promise<string> {
  const client = prClient(projectId)
  const settings = getData().settings
  if (!client) throw new Error("This project's machine is offline. Try again when it's back.")
  if (!settings) throw new Error('Settings are still loading. Try again in a moment.')
  const created = await client.call('threads.create', {
    project_id: projectId,
    provider: { kind: settings.default_provider, instance: 'default' },
    permission_mode: settings.default_permission_mode,
    title: threadTitle(detail.issue),
    message: { parts: [{ type: 'text', text: issuePrompt(detail, repoName) }] },
  })
  await refreshLists()
  openThread(created.id)
  return created.id
}
