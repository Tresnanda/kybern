import type { CollaborationGroupDetail, CollaborationMessage, ContextEntry, Project, ProviderStatus, Thread } from "../src/protocol"

export interface CollaborationReplay {
  detail: CollaborationGroupDetail
  messages: { messages: CollaborationMessage[] }
  context: { entries: ContextEntry[] }
  histories: Record<string, { revisions: ContextEntry[] }>
  threads: Record<string, Thread>
  providers: ProviderStatus[]
  project: Project
}

declare const __COLLAB_REPLAY__: CollaborationReplay | null
export const collaborationReplay = __COLLAB_REPLAY__

// Capture transport is deliberately read-only. Source data is explicitly supplied
// to the fixture build and never imported into the production application.
export function readReplay(method: string, params: Record<string, unknown>) {
  const data = collaborationReplay
  if (!data) throw new Error("No collaboration replay was supplied")
  switch (method) {
    case "collaboration.groups.list": return { groups: [data.detail.group], next_cursor: null }
    case "collaboration.groups.get": return data.detail
    case "collaboration.assignments.list": return { assignments: data.detail.assignments, next_cursor: null }
    case "collaboration.messages.list": return { ...data.messages, next_cursor: null }
    case "collaboration.context.list": return { ...data.context, next_cursor: null }
    case "collaboration.context.history": return { ...data.histories[String(params.entry_id)], next_before_revision: null }
    default: throw new Error(`Capture transport is read-only: ${method}`)
  }
}
