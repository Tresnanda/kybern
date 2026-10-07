/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ProviderMark } from "../src/components/kybern/bits"
import { NativeSubagentComposer } from "../src/views/subagents/NativeSubagentComposer"
import { SubagentStrip } from "../src/views/subagents/SubagentStrip"
import { ComposerPanelStack } from "../src/components/kit/chat/ComposerStackedPanel"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { emptyThreadState } from "../src/state/transcript"
import { childFixture } from "./native-subagents-rpc"
import type { ProviderKind, Thread } from "../src/protocol"
import "../src/index.css"
declare const __COLLAB_THEME__: "dark" | "light"
declare const __COLLAB_STRESS__: string
const theme = __COLLAB_THEME__
const at = "2026-10-08T10:00:00Z"
const thread: Thread = { id: "child", parent_thread_id: "parent", title: "Review the native child message routing", project_id: "project", provider: { kind: "claude-code", instance: "default" }, model: "sonnet", permission_mode: "supervised", status: "running", cwd: "/project", pinned: false, created_at: at, updated_at: at, last_seq: 0,
  subagent: {task_id:"child-task",root_thread_id:"parent",parent_turn_id:"parent-turn",status:"running",backgrounded:false,transcript:true,started_at:at} }
const harnesses: [ProviderKind, string][] = [["claude-code","Claude Code"],["codex","Codex"],["cursor","Cursor"],["opencode","OpenCode"],["pi","Pi"],["omp","Oh My Pi"]]
const layoutAt = Date.now()
const screenshotDurations = [14 * 60 + 12, 13 * 60 + 45, 6 * 3600 + 52 * 60, 6 * 3600 + 34 * 60]
const expectedDurations = ["14m 12s", "13m 45s", "6h 52m", "6h 34m"]
const layoutRows: Thread[] = [...screenshotDurations, 6 * 3600 + 52 * 60 + 30, 13 * 60 + 45].map((seconds,index) => ({
  ...thread, id: `layout-${index}`, parent_thread_id: "layout-parent",
  title: index === 4 ? "Inspect the background process with a very long task title that must leave room for its state and elapsed time" : `Review ${index + 1}: a deliberately long native subagent title including /project/documentation/release-readiness-and-account-isolation.md`,
  model: "Claude Sonnet with a long account-specific model display name",
  status: index >= 4 ? "running" : "idle",
  subagent: {...thread.subagent!, task_id: `layout-task-${index}`, root_thread_id: "layout-parent", parent_turn_id: "layout-turn", status: index >= 4 ? "running" : "completed", backgrounded: index === 4,
    started_at: new Date(layoutAt-seconds*1000).toISOString(), completed_at: index >= 4 ? null : new Date(layoutAt).toISOString(), capabilities: {stop:true,background:true}},
}))
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
function Shell() {
  const child = useStore((state) => state.threads.child)
  return <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><main className="flex min-h-screen flex-col justify-end gap-6 p-4"><section aria-label="Harness logos" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-foreground">{harnesses.map(([kind,label])=><span key={kind} className="flex items-center gap-2"><ProviderMark kind={kind} size={16} />{label}</span>)}</section><section aria-label="Subagent duration layout"><ComposerPanelStack><SubagentStrip threadId="layout-parent" turnRunning turnId="layout-turn" hasActiveAgentTasks fallback={null} /></ComposerPanelStack></section><NativeSubagentComposer thread={child} providers={[]} surfaceMode="single" isFocused /></main></ThemeProviderContext>
}

function inspectDurationLayout() {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-subagent-strip-row]')]
  const geometry = rows.map((row) => {
    const time = row.querySelector<HTMLElement>('[data-subagent-strip-time] [aria-hidden]')!
    const title = row.querySelector<HTMLElement>('[data-subagent-strip-title]')!
    const background = row.querySelector<HTMLElement>('[data-subagent-strip-background]')
    const range = document.createRange(); range.selectNodeContents(time)
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)
    const backgroundRange = document.createRange()
    if (background) backgroundRange.selectNodeContents(background)
    const backgroundRects = background ? [...backgroundRange.getClientRects()].filter((rect)=>rect.width > 0) : []
    const box = row.getBoundingClientRect(), timeBox = time.getBoundingClientRect(), titleBox = title.getBoundingClientRect()
    return {id:row.dataset.subagentStripRow, text:time.textContent, lines:new Set(rects.map((rect)=>Math.round(rect.top*2))).size,
      fits:timeBox.left >= box.left && timeBox.right <= box.right+0.5 && timeBox.top >= box.top-0.5 && timeBox.bottom <= box.bottom+0.5,
      titleBeforeTime:titleBox.right <= timeBox.left-2,
      titleTruncated:title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
      backgroundBeforeTime:!background || (background.getBoundingClientRect().right <= timeBox.left-2 && backgroundRects.every((rect)=>rect.right <= timeBox.left-2)),
      top:box.top,bottom:box.bottom}
  })
  return {geometry, pass:geometry.length === layoutRows.length && geometry.every((row,index)=>row.lines === 1 && row.fits && row.titleBeforeTime && row.titleTruncated && row.backgroundBeforeTime && (index === 0 || row.top >= geometry[index-1]!.bottom-0.5))}
}

function inspectFocusedActions(row: HTMLElement) {
  const box = row.getBoundingClientRect()
  const open = row.querySelector<HTMLElement>('[data-subagent-strip-open]')!.getBoundingClientRect()
  const time = row.querySelector<HTMLElement>('[data-subagent-strip-time]')!
  const buttons = [...row.querySelectorAll<HTMLButtonElement>('button[aria-label^="Stop "],button[aria-label^="Run "]')]
  const geometry = buttons.map((button) => {
    const rect = button.getBoundingClientRect()
    return {label:button.getAttribute("aria-label"),left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
      visible:getComputedStyle(button.parentElement!).opacity === "1",
      fits:rect.left >= open.right && rect.right <= box.right+0.5 && rect.top >= box.top-0.5 && rect.bottom <= box.bottom+0.5}
  })
  return {geometry, pass:geometry.length > 0 && getComputedStyle(time).opacity === "0" && geometry.every((button,index)=>button.visible && button.fits && (index === 0 || button.left >= geometry[index-1]!.right))}
}
async function run() {
  document.documentElement.classList.toggle("dark",theme === "dark")
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = "macos"
  const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] },theme,{electron:true,isMac:true,systemUiFont:true})
  for (const [key,value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key,value)
  useEnvironments.setState({ selectedId:"local",switching:false,profiles:[{id:"local",name:"Native subagents fixture",url:null,environment_id:"fixture",hostname:"Local",local:true}] })
  useStore.getState().set({threads:{child:thread,...Object.fromEntries(layoutRows.map((row)=>[row.id,row]))},selected:{kind:"thread",id:"child"},transcripts:{child:{...emptyThreadState(),loaded:true,thread}},connection:{state:"open"},composerDrafts:{},providers:[]})
  flushSync(() => createRoot(document.getElementById("root")!).render(<Shell />))
  await pause(300)
  const checks: Record<string,boolean> = {}
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!
  checks.normalComposer = !!editor
  checks.harnessLogos = document.querySelectorAll('[aria-label="Harness logos"] svg').length === harnesses.length
  const regularLayout = inspectDurationLayout()
  checks.screenshotDurations = expectedDurations.every((text,index)=>regularLayout.geometry.find((row)=>row.id === `layout-${index}`)?.text === text)
  checks.durationGeometry = regularLayout.pass
  document.documentElement.style.setProperty("--app-font-size-ui","24px")
  document.documentElement.style.fontSize = "32px"
  await pause()
  const largeLayout = inspectDurationLayout()
  checks.largeTextDurationGeometry = largeLayout.pass
  if (__COLLAB_STRESS__ !== "large-text") {
    document.documentElement.style.removeProperty("--app-font-size-ui")
    document.documentElement.style.fontSize = ""
  }
  const backgroundRow = document.querySelector<HTMLElement>('[data-subagent-strip-row="layout-4"]')!
  const stop = backgroundRow.querySelector<HTMLButtonElement>('button[aria-label^="Stop "]')!
  checks.stopActionExists = !!stop
  const regularRowWidth = backgroundRow.getBoundingClientRect().width
  stop.focus(); await pause(250)
  const stopActions = inspectFocusedActions(backgroundRow)
  checks.focusedStopGeometry = stopActions.pass && backgroundRow.getBoundingClientRect().width === regularRowWidth
  stop.click()
  checks.stopTargetsExactChild = childFixture.controls.some((call)=>call.method === "tasks.stop" && call.threadId === "layout-4")
  const foregroundRow = document.querySelector<HTMLElement>('[data-subagent-strip-row="layout-5"]')!
  const background = foregroundRow.querySelector<HTMLButtonElement>('button[aria-label^="Run "]')!
  checks.backgroundActionExists = !!background
  background.focus(); await pause(250)
  const backgroundActions = inspectFocusedActions(foregroundRow)
  checks.focusedBackgroundAndStopGeometry = backgroundActions.pass
  background.click()
  checks.backgroundTargetsExactChild = childFixture.controls.some((call)=>call.method === "tasks.background" && call.threadId === "layout-5")
  const openChild = backgroundRow.querySelector<HTMLButtonElement>('[data-subagent-strip-open]')!
  openChild.click()
  const selected = useStore.getState().selected
  checks.childNavigation = selected.kind === "thread" && selected.id === "layout-4" && childFixture.controls.some((call)=>call.method === "threads.get" && call.threadId === "layout-4")
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
  checks.completedDisclosure = document.body.textContent!.includes("This subagent has finished. Send an undelivered message to its parent.") && !document.body.textContent!.includes("Messages arrive at this subagent’s next tool call")
  checks.explicitRecovery = !!forward && document.body.textContent!.includes("Not delivered — subagent finished")
  forward?.click()
  await pause(250)
  checks.forwardAcknowledged = document.body.textContent!.includes("Queued for parent") && childFixture.calls.filter((method) => method === "subagents.send_to_parent").length === 1
  checks.noOverflow = document.documentElement.scrollWidth <= innerWidth
  const target = window as unknown as {webkit?:{messageHandlers?:{bench?:{postMessage:(text:string)=>void}}}}
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({pass:Object.values(checks).every(Boolean),checks,theme,regularLayout,largeLayout,stopActions,backgroundActions,largeText:__COLLAB_STRESS__ === "large-text"}))
}
void run().catch((error) => {
  const target = window as unknown as {webkit?:{messageHandlers?:{bench?:{postMessage:(text:string)=>void}}}}
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({pass:false,error:String(error)}))
})
