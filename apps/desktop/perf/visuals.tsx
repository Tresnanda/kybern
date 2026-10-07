import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { VisualReply } from "../src/views/VisualReply"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { fixture, connectFixture, closeFixture, transport } from "./visuals-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
async function waitFor(condition: () => unknown,label: string) { const until = performance.now()+8000; while (!condition() && performance.now()<until) await sleep(20); check(condition(),label) }
function button(text: string) { const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.trim()===text); check(result,`Missing button ${text}`); return result }
const root = createRoot(document.getElementById("root")!)
const reports = new Map<Window,{counter: number; interval: number; raf: number; background: string; foreground: string; table: number; bars: number; isolated: boolean; image: boolean; visible: boolean; accent: string}>()
window.addEventListener("message",event=>{ if (event.origin === "null" && event.data?.fixture === "kybern-visual" && event.source) reports.set(event.source as Window,event.data) })
function probe(frame: HTMLIFrameElement,action = "probe") { frame.contentWindow!.postMessage({fixture:"kybern-visual-command",action},"*") }
async function snapshot(frame: HTMLIFrameElement) { reports.delete(frame.contentWindow!); probe(frame); await waitFor(()=>reports.has(frame.contentWindow!),"Visual responds to probe"); return reports.get(frame.contentWindow!)! }
function appearance(variant: "dark" | "light") {
  const root = document.documentElement; root.classList.toggle("dark",variant==="dark")
  const built = buildThemeCssVariables({codeThemeId:DEFAULT_THEME_STATE.codeThemeIds[variant],theme:DEFAULT_THEME_STATE.chromeThemes[variant]},variant,{electron:true,isMac:true,systemUiFont:true})
  for (const [key,value] of Object.entries(built.variables)) root.style.setProperty(key,value)
}
function report(value: unknown) { (window as unknown as {webkit:{messageHandlers:{bench:{postMessage:(text:string)=>void}}}}).webkit.messageHandlers.bench.postMessage(JSON.stringify(value)) }
async function run() {
  await connectFixture(); appearance("dark")
  flushSync(()=>root.render(<main id="pane" className="mx-auto min-w-0 max-w-[728px] bg-background px-4 py-6 text-foreground"><VisualReply threadId={fixture.thread_id} visual={fixture.visual} /></main>))
  await waitFor(()=>!!document.querySelector("iframe"),"Inline visual loads")
  const inline = document.querySelector<HTMLIFrameElement>("iframe")!; const dark = await snapshot(inline)
  check(dark.isolated && dark.image && dark.table===3 && dark.bars===3,"Script, formatted SVG/table, opaque origin and deleted local image render")
  await waitFor(()=>Number.parseFloat(inline.style.height)<fixture.visual.height,"Content height fits inline frame")
  probe(inline,"click"); await waitFor(()=>reports.get(inline.contentWindow!)?.counter===1,"Counter is interactive")
  const beforeThemeLoads = transport.frameLoads; appearance("light"); await sleep(100)
  const light = await snapshot(inline); check(light.foreground!==dark.foreground && light.background!==dark.background,"Theme follows live without reload")
  check(transport.frameLoads===beforeThemeLoads && light.counter===1,"Theme preserves document and counter")
  document.documentElement.style.setProperty("--color-text-accent","#d43f77"); await sleep(100); check((await snapshot(inline)).accent==="rgb(212, 63, 119)","Custom theme updates chart colors")
  const originalHeight = inline.style.height
  window.postMessage({kind:"kybern-visual-size",height:1900},"*"); await sleep(40); check(inline.style.height===originalHeight,"Other windows cannot spoof height")
  inline.contentWindow!.postMessage({fixture:"kybern-visual-command",action:"spoof-link"},"*"); await sleep(40); check(transport.opened.length===0,"Script cannot open the browser without user activation")
  button("Expand visual").click(); await waitFor(()=>document.querySelectorAll("iframe").length===2,"Expanded visual loads")
  const expanded = [...document.querySelectorAll<HTMLIFrameElement>("iframe")].at(-1)!; await snapshot(expanded)
  probe(expanded,"click"); await waitFor(()=>reports.get(expanded.contentWindow!)?.counter===1,"Expanded page is interactive")
  button("View source").click(); await waitFor(()=>!!document.querySelector("[data-visual-source]"),"Source inspection loads")
  check(document.querySelector("[data-visual-source]")!.textContent!.includes("data:image/svg+xml;base64,"),"Saved source embeds the removed image")
  const source = document.querySelector<HTMLPreElement>("[data-visual-source]")!; source.focus(); check(document.activeElement===source,"Source supports keyboard focus")
  await sleep(100); const pausedBefore = await snapshot(expanded); await sleep(150); const pausedAfter = await snapshot(expanded)
  check(pausedAfter.interval===pausedBefore.interval && pausedAfter.raf===pausedBefore.raf && !pausedAfter.visible,"Hidden source pane pauses intervals and frame loops")
  const loads = transport.frameLoads; button("Show visual").click(); await sleep(80)
  check(document.querySelectorAll<HTMLIFrameElement>("iframe")[1]===expanded && transport.frameLoads===loads,"Source toggle keeps the same document")
  check((await snapshot(expanded)).counter===1,"Source toggle preserves counter")
  document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); await waitFor(()=>document.querySelectorAll("iframe").length===1,"Dialog closes and releases its frame")
  check(document.querySelector("iframe")===inline && (await snapshot(inline)).counter===1,"Closing expanded visual preserves inline document")
  const pane = document.getElementById("pane")!; pane.style.opacity="0"; await sleep(100)
  const hiddenBefore = await snapshot(inline); await sleep(150); const hiddenAfter = await snapshot(inline)
  check(hiddenAfter.interval===hiddenBefore.interval && hiddenAfter.raf===hiddenBefore.raf,"Inactive mounted pane pauses page loops")
  pane.style.opacity="1"; await sleep(100); check((await snapshot(inline)).visible,"Page resumes when pane returns")
  pane.style.width="360px"; await sleep(100); check(inline.getBoundingClientRect().width<=360,"Responsive narrow layout")
  button("Save HTML").click(); await waitFor(()=>transport.saved.length===1,"Save forwards the complete durable source"); check(transport.saved[0].name.endsWith(".html") && transport.saved[0].html.includes("data:image/svg+xml;base64,"),"Saved HTML retains embedded images");
  root.unmount(); closeFixture(); report({pass:true,opaqueScript:true,formattedTable:true,svgChart:true,durableEmbeddedImage:true,liveTheme:true,sourceState:true,hiddenPause:true,narrowLayout:true})
}
run().catch(error=>{closeFixture();report({pass:false,error:String(error)})})
