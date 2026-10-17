// The slash commands of an open thread (`views/Thread.tsx` `commands`): sessions,
// compact, the harness's own commands, new, reconnect, stop, the dock panels,
// pull request, archive, settings and usage.
import { useMemo } from 'react'
import { threadCommandSpecs, type ThreadCommandId } from '@/lib/threadCommands'
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

export function useThreadCommands(thread: Thread | null, attach: () => void): SlashCommand[] {
  const nativeCommands = useApp(s => (thread && s.open.thread?.id === thread.id ? s.open.providerCommands : undefined) ?? EMPTY)
  const freeChat = !!thread && isFreeChatProject(thread.project_id)
  const canCompact = !!thread?.provider_session_id && (['codex', 'pi', 'omp', 'opencode'].includes(thread!.provider.kind) || nativeCommands.some(command => command.name === 'compact'))
  return useMemo<SlashCommand[]>(() => {
    if (!thread) return []
    const panel = (tab: DockTab) => () => { setDock(thread.id, { open: true }); chooseTab(thread.id, tab) }
    const sessions = () => setNav({ sessions: { projectId: freeChat ? null : thread.project_id } })
    const client = () => getClient()!
    const handlers: Record<ThreadCommandId, { icon: string; run: () => void }> = {
      resume: { icon: G.clock, run: sessions },
      sessions: { icon: G.clock, run: sessions },
      compact: { icon: G.workflow, run: () => {
        void client().call('threads.compact', { thread_id: thread.id }).catch(error => toast.error('Unable to compact context', { description: errorText(error) }))
      } },
      new: { icon: N.newThread, run: () => newThread(freeChat ? undefined : thread.project_id) },
      reconnect: { icon: G.workflow, run: () => {
        void client().call('threads.release', { thread_id: thread.id }).then(() => toast('Agent released', { description: 'Your next message resumes the saved conversation.' })).catch(error => toast.error('Unable to release agent', { description: errorText(error) }))
      } },
      stop: { icon: N.stop, run: () => void interruptThread(thread.id).catch(() => {}) },
      activity: { icon: G.workflow, run: panel('activity') },
      agents: { icon: N.users, run: panel('agents') },
      attach: { icon: G.paperclip, run: attach },
      terminal: { icon: G.terminal, run: panel('terminal') },
      changes: { icon: G.changes, run: panel('changes') },
      files: { icon: G.folders, run: panel('explorer') },
      environment: { icon: N.branch, run: panel('changes') },
      pr: { icon: N.pullRequest, run: () => {
        void client().call('github.pr.create', { thread_id: thread.id })
          .then(pr => toast('Pull request opened', { description: pr.title, action: { label: 'Open', onClick: () => void launchBrowser(pr.url) } }))
          .catch(error => toast.error('Unable to create pull request', { description: errorText(error) }))
      } },
      archive: { icon: N.archive, run: () => void archiveThread(thread.id) },
      settings: { icon: N.settings, run: () => setNav({ settingsOpen: true }) },
      usage: { icon: N.usage, run: () => goPage('usage') },
    }
    // The names, hints and order are the desktop's (`lib/threadCommands.ts`); only the icons and handlers are ours.
    return threadCommandSpecs({ freeChat, canCompact, providerKind: thread.provider.kind, nativeCommands }).map((spec): SlashCommand =>
      spec.kind === 'native'
        ? { name: spec.name, invocation: spec.invocation, hint: spec.hint, icon: G.terminal, insert: true, run: () => {} }
        : { name: spec.name, hint: spec.hint, ...handlers[spec.id] })
  }, [thread?.id, thread?.project_id, thread?.provider.kind, freeChat, canCompact, nativeCommands, attach])
}
