import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/hot") {
      return {
        shortCircuit: true,
        url: new URL("./src/lib/hot.ts", import.meta.url).href,
      }
    }
    return nextResolve(specifier, context)
  },
})

const { buildWorkHierarchy, groupTurns, shouldRevealLiveText } = await import("./src/state/transcript.ts")

const user = {
  kind: "user",
  id: "user-1",
  turnId: "turn-1",
  at: "2026-09-03T00:00:00Z",
  message: { parts: [{ type: "text", text: "Investigate this" }] },
}

const assistant = {
  kind: "assistant",
  id: "assistant-1",
  turnId: "turn-1",
  at: "2026-09-03T00:00:01Z",
  text: "Here is the answer.",
  thinking: "I should inspect the implementation first.",
  complete: false,
}

test("OMP reasoning stays in work when answer text streams on the same message", () => {
  const [group] = groupTurns([user, assistant])

  assert.equal(group.answerLive?.text, assistant.text)
  assert.equal(group.answerLive?.thinking, "")
  assert.deepEqual(group.work, [
    {
      ...assistant,
      id: "reasoning:assistant-1",
      text: "",
    },
  ])
})

test("OMP reasoning stays in work after its combined assistant message settles", () => {
  const turnEnd = {
    kind: "turn_end",
    id: "end:turn-1",
    turnId: "turn-1",
    at: "2026-09-03T00:00:02Z",
  }
  const [group] = groupTurns([user, { ...assistant, complete: true }, turnEnd])

  assert.equal(group.answer?.text, assistant.text)
  assert.equal(group.answer?.thinking, "")
  assert.equal(group.work[0]?.kind, "assistant")
  assert.equal(group.work[0]?.id, "reasoning:assistant-1")
  assert.equal(group.work[0]?.thinking, assistant.thinking)
})

test("a tiny partial token keeps the live thinking state instead of flashing a stalled answer", () => {
  assert.equal(shouldRevealLiveText("I", false), false)
  assert.equal(shouldRevealLiveText("The sub", false), true)
  assert.equal(shouldRevealLiveText("Done.", true), true)
})

test("subagent tools stay beneath the delegated task that ran them", () => {
  const tool = (id, parentId = null) => ({
    kind: "tool",
    id: `tool:${id}`,
    turnId: "turn-1",
    at: "2026-09-03T00:00:01Z",
    call: { id, name: "Bash", input: {}, parent_id: parentId },
    stream: "",
    output: null,
    isError: false,
    complete: true,
  })
  const delegated = tool("agent")
  delegated.call.name = "Agent"
  const childRead = tool("child-read", "agent")
  const nestedAgent = tool("nested-agent", "agent")
  nestedAgent.call.name = "Agent"
  const grandchildSearch = tool("grandchild-search", "nested-agent")
  const rootCommand = tool("root-command")
  const orphan = tool("orphan", "missing-parent")
  const cycleA = tool("cycle-a", "cycle-b")
  const cycleB = tool("cycle-b", "cycle-a")

  const hierarchy = buildWorkHierarchy([
    delegated,
    childRead,
    nestedAgent,
    grandchildSearch,
    rootCommand,
    orphan,
    cycleA,
    cycleB,
  ])

  assert.deepEqual(
    hierarchy.roots.map((block) => block.call.id),
    ["agent", "root-command", "orphan", "cycle-a", "cycle-b"],
  )
  assert.deepEqual(
    hierarchy.childrenByParent.get("agent")?.map((block) => block.call.id),
    ["child-read", "nested-agent"],
  )
  assert.deepEqual(
    hierarchy.childrenByParent.get("nested-agent")?.map((block) => block.call.id),
    ["grandchild-search"],
  )
})
