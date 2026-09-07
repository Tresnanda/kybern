// Native WebKit coverage of the production transcript across a Claude wake-up.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { applyEvent, emptyThreadState, groupTurns } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import type { ThreadEvent } from "../src/protocol"
import eventsJson from "../../../fixtures/transcript/claude-process-resumed.json"
import "../src/index.css"

const events = eventsJson as ThreadEvent[]
const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let state = { ...emptyThreadState(), loaded: true }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function publish(event: ThreadEvent) {
  state = applyEvent(state, event)
  flushSync(() => useStore.getState().set({ transcripts: { fixture: state } }))
}
async function run() {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark")
    state = { ...emptyThreadState(), loaded: true }
    flushSync(() => root.render(<ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div className="flex h-screen flex-col"><Transcript threadId="fixture" bottomInset={0} /></div>
    </ThemeProviderContext>))
    for (const event of events) {
      publish(event)
      await sleep(35)
      if (event.kind === "turn_resumed") {
        check(groupTurns(state.blocks)[0].running, "Resumed turn is not running")
        check(!document.querySelector('[data-message-role="assistant"] [data-slot="message-content"]'), "Provisional answer remained prominent while resuming")
        check(document.querySelector('[data-timeline-row-kind="live-work"]'), "Live work is missing")
      }
    }
    await sleep(500)
    check(document.querySelectorAll("[data-turn-id]").length === 1, "Anonymous second Worked group appeared")
    check(document.querySelectorAll('[data-message-role="user"]').length === 1, "Continuation invented a user message")
    const answer = document.querySelector('[data-message-role="assistant"] [data-slot="message-content"]')!
    check(answer?.textContent?.includes("All four replay arms completed."), "Final answer is missing")
    check(answer.querySelector("strong")?.textContent === "The results are ready.", "Final Markdown was not formatted")
    check(!answer.textContent?.includes("I will report when"), "Waiting message is still the final answer")
    const disclosure = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Worked for"))
    if (disclosure?.getAttribute("aria-expanded") !== "true") disclosure?.click()
    await sleep(500)
    check(document.body.textContent?.includes("replay.log"), "Follow-up tool did not stay inside its parent work group")
  }
  return { pass: true, themes: 2, turns: 1, userMessages: 1, formattedFinal: true, followUpTools: true }
}
const report = (result: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(result))
run().then(report).catch((error) => report({ pass: false, error: String(error), stack: error.stack }))
