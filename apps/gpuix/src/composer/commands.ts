// The slash commands of an open thread (`views/Thread.tsx` `commands`): sessions,
// compact, the harness's own commands, new, reconnect, stop, the dock panels,
// pull request, archive, settings and usage.
import { useMemo } from 'react'
import { PROVIDER_LABEL } from '@/lib/format'
import { isFreeChatProject, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { chooseTab, setDock, type DockTab } from '../dock/store.ts'
import { N } from '../nav/glyphs.ts'
import { goPage, newThread } from '../nav/history.ts'
import { archiveThread } from '../nav/actions.ts'
import { setNav } from '../nav/store.ts'
import { launchBrowser } from '../preview/browser.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient, useApp } from '../state.ts'
import { G } from './glyphs.ts'
import { errorText, interruptThread } from './store.ts'
import type { SlashCommand } from './Completion.tsx'

const EMPTY: never[] = []
/** Names the harness may also define; the desktop prefixes those so both stay reachable. */
const LOCAL = ['resume', 'sessions', 'new', 'stop', 'activity', 'attach', 'changes', 'terminal', 'files', 'environment', 'pr', 'archive', 'settings', 'usage']

export function useThreadCommands(thread: Thread | null, attach: () => void): SlashCommand[] {
  const nativeCommands = useApp(s => (thread && s.open.thread?.id === thread.id ? s.open.providerCommands : undefined) ?? EMPTY)
  const freeChat = !!thread && isFreeChatProject(thread.project_id)
  const canCompact = !!thread?.provider_session_id && (['codex', 'pi', 'omp', 'opencode'].includes(thread!.provider.kind) || nativeCommands.some(command => command.name === 'compact'))
  return useMemo<SlashCommand[]>(() => {
    if (!thread) return []
    const panel = (tab: DockTab) => () => { setDock(thread.id, { open: true }); chooseTab(thread.id, tab) }
    const sessions = () => setNav({ sessions: { projectId: freeChat ? null : thread.project_id } })
    const client = () => getClient()!
    return [
      { name: 'resume', hint: 'Continue a saved session', icon: G.clock, run: sessions },
      { name: 'sessions', hint: 'Browse saved sessions', icon: G.clock, run: sessions },
      ...(canCompact ? [{ name: 'compact', hint: 'Compact context and keep conversation history', icon: G.workflow, run: () => {
        void client().call('threads.compact', { thread_id: thread.id }).catch(error => toast.error('Unable to compact context', { description: errorText(error) }))
      } }] : []),
      ...nativeCommands.filter(command => command.name !== 'compact').map(command => ({
        name: LOCAL.includes(command.name) ? `harness:${command.name}` : command.name,
        invocation: command.name,
        hint: `${PROVIDER_LABEL[thread.provider.kind]} · ${command.description}`,
        icon: G.terminal, insert: true, run: () => {},
      })),
      { name: 'new', hint: freeChat ? 'Start a new free chat' : 'Start a new thread in this project', icon: N.newThread, run: () => newThread(freeChat ? undefined : thread.project_id) },
      { name: 'reconnect', hint: 'Release the idle agent; resume history on your next message', icon: G.workflow, run: () => {
        void client().call('threads.release', { thread_id: thread.id }).then(() => toast('Agent released', { description: 'Your next message resumes the saved conversation.' })).catch(error => toast.error('Unable to release agent', { description: errorText(error) }))
      } },
      { name: 'stop', hint: 'Interrupt the running turn', icon: N.stop, run: () => void interruptThread(thread.id).catch(() => {}) },
      { name: 'activity', hint: 'Show agents and background processes', icon: G.workflow, run: panel('activity') },
      { name: 'agents', hint: 'Start and coordinate helper agents', icon: N.users, run: panel('agents') },
      { name: 'attach', hint: 'Attach files or images', icon: G.paperclip, run: attach },
      { name: 'terminal', hint: 'Open a terminal in this thread', icon: G.terminal, run: panel('terminal') },
      ...(!freeChat ? [
        { name: 'changes', hint: 'Show the changes panel', icon: G.changes, run: panel('changes') },
        { name: 'files', hint: 'Browse the project files', icon: G.folders, run: panel('explorer') },
        { name: 'environment', hint: 'Show branch, commit and pull request controls', icon: N.branch, run: panel('changes') },
        { name: 'pr', hint: 'Create a pull request from this thread', icon: N.pullRequest, run: () => {
          void client().call('github.pr.create', { thread_id: thread.id })
            .then(pr => toast('Pull request opened', { description: pr.title, action: { label: 'Open', onClick: () => void launchBrowser(pr.url) } }))
            .catch(error => toast.error('Unable to create pull request', { description: errorText(error) }))
        } },
      ] : []),
      { name: 'archive', hint: 'Archive this thread', icon: N.archive, run: () => void archiveThread(thread.id) },
      { name: 'settings', hint: 'Open settings', icon: N.settings, run: () => setNav({ settingsOpen: true }) },
      { name: 'usage', hint: 'Review token usage and cost', icon: N.usage, run: () => goPage('usage') },
    ]
  }, [thread?.id, thread?.project_id, thread?.provider.kind, freeChat, canCompact, nativeCommands, attach])
}
