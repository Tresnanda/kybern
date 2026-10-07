import type { SubagentMessage, UserMessage } from "../src/protocol"
export * from "../src/state/rpc"
export const childFixture = { calls: [] as string[], controls: [] as { method: string; threadId: string }[], messages: [] as SubagentMessage[] }
export async function loadThread(threadId: string) { childFixture.controls.push({method:"threads.get",threadId}) }
export async function stopSubagent(threadId: string) { childFixture.controls.push({method:"tasks.stop",threadId}) }
export async function backgroundSubagent(threadId: string) { childFixture.controls.push({method:"tasks.background",threadId}) }
const connection = {
  async call(method: string, params: { thread_id: string; id?: string; message?: UserMessage; message_id?: string }) {
    childFixture.calls.push(method)
    if (method === "subagents.messages") return childFixture.messages
    if (method === "subagents.send") {
      const message: SubagentMessage = { id: params.id!, thread_id: params.thread_id, root_thread_id: "parent", task_id: "child-task", native_task_id: "child-task", session_instance_id: "admitted-process", turn_id: "child-turn", message: params.message!, status: "pending", error: null, parent_message_id: null, parent_queued: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      childFixture.messages.push(message)
      return message
    }
    if (method === "subagents.send_to_parent") {
      const message = childFixture.messages.find((message) => message.id === params.message_id)!
      const result = { ...message, parent_message_id: "parent-message", parent_queued: true, updated_at: new Date().toISOString() }
      childFixture.messages = childFixture.messages.map((message) => message.id === result.id ? result : message)
      return result
    }
    throw new Error(`Unexpected native child request ${method}`)
  },
}
export function activeRuntime() { return { rpc: () => connection } }
