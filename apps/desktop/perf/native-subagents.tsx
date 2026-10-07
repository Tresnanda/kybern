/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { NativeSubagentComposer } from "../src/views/subagents/NativeSubagentComposer"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { emptyThreadState } from "../src/state/transcript"
import { childFixture } from "./native-subagents-rpc"
import type { Thread } from "../src/protocol"
import "../src/index.css"
declare const __COLLAB_THEME__: "dark" | "light"
const theme = __COLLAB_THEME__
const at = "2026-10-08T10:00:00Z"
const thread: Thread = { id: "child", parent_thread_id: "parent", title: "Review the native child message routing", project_id: "project", provider: { kind: "claude-code", instance: "default" }, model: "sonnet", permission_mode: "supervised", status: "running", cwd: "/project", pinned: false, created_at: at, updated_at: at, last_seq: 0,
  subagent: {task_id:"child-task",root_thread_id:"parent",parent_turn_id:"parent-turn",status:"running",backgrounded:false,transcript:true,started_at:at} }
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
function Shell() {
  const child = useStore((state) => state.threads.child)
  return <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><main className="flex h-screen flex-col justify-end p-4"><NativeSubagentComposer thread={child} providers={[]} surfaceMode="single" isFocused /></main></ThemeProviderContext>
}
async function run() {
  document.documentElement.classList.toggle("dark",theme === "dark")
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = "macos"
  const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] },theme,{electron:true,isMac:true,systemUiFont:true})
  for (const [key,value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key,value)
  useEnvironments.setState({ selectedId:"local",switching:false,profiles:[{id:"local",name:"Native subagents fixture",url:null,environment_id:"fixture",hostname:"Local",local:true}] })
  useStore.getState().set({threads:{child:thread},selected:{kind:"thread",id:"child"},transcripts:{child:{...emptyThreadState(),loaded:true,thread}},connection:{state:"open"},composerDrafts:{},providers:[]})
  flushSync(() => createRoot(document.getElementById("root")!).render(<Shell />))
  await pause(300)
  const checks: Record<string,boolean> = {}
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!
  checks.normalComposer = !!editor
  editor.focus()
  document.execCommand("insertText",false,"Keep this complete message with a long file path /project/docs/native-child-routing-and-attachment-references.md.")
  editor.dispatchEvent(new KeyboardEvent("keyup",{key:".",bubbles:true}))
  await pause()
  editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
  await pause(250)
  checks.onlyChildSend = childFixture.calls.includes("subagents.send") && !childFixture.calls.some((method) => method === "threads.send" || method === "threads.steer" || method === "threads.queue")
  checks.pendingIsVisible = !!document.querySelector('[data-subagent-message-status="pending"]') && document.body.textContent!.includes("Waiting for next tool call")
  const failed = {...childFixture.messages[0]!,status:"failed" as const,error:"Not delivered — subagent finished.",updated_at:new Date().toISOString()}
  childFixture.messages = [failed]
  useStore.getState().set((state) => ({threads:{...state.threads,child:{...thread,status:"idle",subagent:{...thread.subagent!,status:"completed",completed_at:new Date().toISOString()}}},transcripts:{...state.transcripts,child:{...state.transcripts.child,subagentMessages:[failed]}}}))
  await pause(250)
  const forward = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send to parent")
  checks.explicitRecovery = !!forward && document.body.textContent!.includes("Not delivered — subagent finished")
  forward?.click()
  await pause(250)
  checks.forwardAcknowledged = document.body.textContent!.includes("Queued for parent") && childFixture.calls.filter((method) => method === "subagents.send_to_parent").length === 1
  checks.noOverflow = document.documentElement.scrollWidth <= innerWidth
  const target = window as unknown as {webkit?:{messageHandlers?:{bench?:{postMessage:(text:string)=>void}}}}
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({pass:Object.values(checks).every(Boolean),checks,theme}))
}
void run().catch((error) => {
  const target = window as unknown as {webkit?:{messageHandlers?:{bench?:{postMessage:(text:string)=>void}}}}
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({pass:false,error:String(error)}))
})
