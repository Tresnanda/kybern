// Links inside notes: in-app thread links stay in the app, the rest open in the system browser.
import { toast } from "sonner"

import { openExternal } from "@/lib/tauri"
import { loadThread } from "@/state/rpc"
import { useStore } from "@/state/store"

const THREAD_LINK = /^kybern:\/\/thread\/([0-9a-f-]{36})\/?$/i
const EXTERNAL_LINK = /^(https?:|mailto:|tel:)/i

/** Open a link the way the app does: threads in place, everything else in the system browser. */
export function openNoteLink(href: string) {
  const thread = THREAD_LINK.exec(href)
  if (thread) {
    const id = thread[1]!
    const state = useStore.getState()
    if (!state.threads[id]) {
      toast("That thread no longer exists")
      return
    }
    state.selectThread(id)
    void loadThread(id)
    return
  }
  if (EXTERNAL_LINK.test(href)) void openExternal(href)
}
