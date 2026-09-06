// Native interaction and layout checks against the production question panels.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AsyncQuestionPanel } from "../src/views/AsyncQuestionPanel"
import { UserInputPanel } from "../src/views/UserInputPanel"
import { ComposerColumnFrame } from "../src/components/kit/chat/ComposerColumnFrame"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ApprovalRequest, AsyncQuestionRequest } from "../src/protocol"
import { sent, transport } from "./questions-rpc"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const root = document.documentElement
const view = createRoot(document.getElementById("root")!)
const title = "Where do you notice the lag most—scrolling long conversations, typing, opening menus/switching threads, or while the agent is streaming a response?"
const request: AsyncQuestionRequest = { id: "question-1", questions: [{ title, options: [] }] }
const approval: ApprovalRequest = { id: "approval-1", thread_id: "thread-1", turn_id: "turn-1", tool_name: "request_user_input", summary: "Choose where to start", suggestions: [], created_at: "2026-09-06T00:00:00Z", input: { questions: [{ id: "scope", question: "Where should the investigation start?", options: [{ label: "Long conversations", description: "Check scrolling and responsiveness as the history grows." }, { label: "Streaming responses", description: "Check typing and menus while the agent is working." }] }] } }
let revision = 0
function theme(variant: "dark" | "light") {
  root.classList.toggle("dark", variant === "dark")
  root.dataset.themeVariant = variant
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
  root.style.setProperty("--app-font-size-ui", "12px")
  root.style.setProperty("--app-font-size-ui-lg", "13px")
  root.style.setProperty("--app-font-size-ui-sm", "11px")
}
function render(mode: "async" | "blocking", questions = request, width = 720, input = approval) {
  revision++
  flushSync(() => view.render(<main style={{ padding: 24, minHeight: "100vh", background: "var(--background)" }}>
    <div id="frame" style={{ width, maxWidth: "100%", marginInline: "auto" }}>
      <ComposerColumnFrame>
        {mode === "async" ? <AsyncQuestionPanel key={revision} threadId="thread-1" request={questions} count={1} /> : <UserInputPanel key={revision} approval={input} count={1} />}
      </ComposerColumnFrame>
    </div>
  </main>))
}
function check(condition: unknown, message: string) { if (!condition) throw new Error(message) }
function field() { return document.querySelector<HTMLTextAreaElement>("textarea")! }
function submit() { return document.querySelector<HTMLButtonElement>('button[type="submit"]')! }
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value)
  flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })))
}
function click(el: HTMLElement) { flushSync(() => el.click()) }
function fits() {
  const panel = document.querySelector<HTMLElement>(".question-panel")!
  const rect = panel.getBoundingClientRect()
  check(panel.scrollWidth <= panel.clientWidth + 1, "Panel overflows horizontally")
  const button = submit().getBoundingClientRect()
  check(button.bottom <= rect.bottom + 1 && button.right <= rect.right + 1, "Send action is clipped")
}
async function run() {
  theme("dark")
  render("async")
  check(submit().disabled, "Empty answer can be sent")
  const answer = "Mostly scrolling long conversations.\nI’m not sure about short ones, but investigate everywhere."
  type(field(), answer)
  check(!submit().disabled && field().value === answer, "Multiline answer was lost")
  check(!getComputedStyle(field()).fontFamily.toLowerCase().includes("mono"), "Answer uses monospace")
  field().focus()
  check(document.activeElement === field(), "Answer cannot receive keyboard focus")
  check(sent.length === 0, "Typing submitted an answer")
  transport.fail = true
  click(submit())
  check(submit().disabled && field().matches(":disabled"), "Sending does not disable edits")
  await sleep(100)
  check(!!document.querySelector('[role="alert"]') && field().value === answer && !submit().disabled, "Failed send lost the draft or prevented retry")
  transport.fail = false
  click(submit())
  await sleep(100)
  check(JSON.stringify(sent.at(-1)).includes(JSON.stringify(answer).slice(1, -1)), "Submitted multiline content changed")
  for (const variant of ["dark", "light"] as const) {
    theme(variant)
    for (const width of [280, 400, 920]) {
      render("async", { id: "many", questions: Array.from({ length: 3 }, (_, index) => ({ title: `${index + 1}. ${title}`, options: ["A long option that wraps naturally when the question panel is narrow", "Another option"] })) }, width)
      fits()
      const body = document.querySelector<HTMLElement>(".question-panel-body")!
      check(body.scrollHeight > body.clientHeight, "Long requests are not bounded")
      body.scrollTop = body.scrollHeight
      fits()
      root.dir = "rtl"
      fits()
      root.dir = "ltr"
    }
  }
  theme("dark")
  render("async", { id: "choice", questions: [{ title: "Choose a starting point", options: ["Scrolling", "Streaming"] }] })
  const before = sent.length
  click(document.querySelector<HTMLInputElement>('input[type="radio"]')!)
  check(!submit().disabled && sent.length === before, "Choice submits without an explicit send")
  type(field(), "Typing and menus")
  check(!document.querySelector<HTMLInputElement>('input[type="radio"]')!.checked, "Custom answer leaves an option selected")
  render("blocking")
  click(document.querySelector<HTMLInputElement>('input[type="radio"]')!)
  type(field(), "Investigate everything\nStart with scrolling")
  check(!document.querySelector<HTMLInputElement>('input[type="radio"]')!.checked, "Blocking custom answer leaves an option selected")
  click(submit())
  await sleep(100)
  check(JSON.stringify(sent.at(-1)).includes("Investigate everything"), "Blocking answer payload is missing")
  render("blocking", request, 360, { ...approval, input: { questions: [{ id: "scope", question: "What should be checked?", multiple: true, options: ["Scrolling", "Streaming"] }] } })
  for (const option of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) click(option)
  type(field(), "Menus too")
  check(document.querySelectorAll('input[type="checkbox"]:checked').length === 2, "Extra answer cleared multiple choices")
  click(submit())
  await sleep(100)
  check(JSON.stringify(sent.at(-1)).includes('["Scrolling","Streaming","Menus too"]'), "Multiple choices and extra answer changed")
  render("blocking", request, 320, { ...approval, input: { questions: [{ id: "secret", question: "Enter the secret", isSecret: true }] } })
  check(!!document.querySelector('input[type="password"]') && !document.querySelector("textarea"), "Secret answer was exposed")
  render("async", request, 720)
  root.style.setProperty("--app-font-size-ui", "20px")
  root.style.setProperty("--app-font-size-ui-lg", "22px")
  fits()
  theme("dark")
  render("async")
  type(field(), answer)
  field().focus()
  if (import.meta.env.VITE_QUESTION_PREVIEW === "choices") {
    theme("light")
    render("blocking", request, 360)
    click(document.querySelector<HTMLInputElement>('input[type="radio"]')!)
  }
  await sleep(250)
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, checks: "multiline, system font, focus, explicit send, busy, retry, payloads, secret, dark/light, 280–920px, RTL, text resizing, bounded scrolling" }))
}
run().catch((error) => {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) }))
})
