import { getState } from '../state.ts'
import { goPage, openThread } from '../nav/history.ts'
import { focusedGroup, openTab } from '../tabs/open.ts'
import { toast } from '../shell/toasts.tsx'
import type { PrTarget } from './tabTargets.ts'

/** The page's explicit action: open beside the conversation already in the horizontal strip. */
export function openPullTab(target: PrTarget) {
  const state=getState()
  const host=focusedGroup()?.group.threadId ?? state.selectedId ?? state.threads.find(t=>!t.subagent&&!t.delegation&&t.status!=='archived')?.id
  if(!host){ toast.error('Open a conversation first', {description:'Pull request tabs open beside a conversation.'}); return }
  openTab(host,{kind:'pr',...target})
  if(state.selectedId!==host)openThread(host)
  else goPage('home')
}
