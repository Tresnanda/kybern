/* eslint-disable react-refresh/only-export-components -- fixture defines a helper component beside its runner */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { VisualReply } from "../src/views/VisualReply"
import { DockPreviewPane } from "../src/views/dock/VisualPreviewPanel"
import { useStore } from "../src/state/store"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useSyncExternalStore } from "react"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { fixture, connectFixture, closeFixture, transport } from "./visuals-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
async function waitFor(condition: () => unknown,label: string,ms = 8000) { const until = performance.now()+ms; while (!condition() && performance.now()<until) await sleep(20); check(condition(),label) }
const root = createRoot(document.getElementById("root")!)
const threadId = fixture.thread_id
type Report = {counter: number; interval: number; raf: number; background: string; foreground: string; table: number; bars: number; isolated: boolean; image: boolean; visible: boolean; accent: string; runningAnimations: number; pausedAnimations: number}
const reports = new Map<Window,Report>()
window.addEventListener("message",event=>{ if (event.origin === "null" && event.data?.fixture === "kybern-visual" && event.source) reports.set(event.source as Window,event.data) })
function probe(frame: HTMLIFrameElement,action = "probe") { frame.contentWindow!.postMessage({fixture:"kybern-visual-command",action},"*") }
async function snapshot(frame: HTMLIFrameElement) { reports.delete(frame.contentWindow!); probe(frame); await waitFor(()=>reports.has(frame.contentWindow!),"Visual responds to probe"); return reports.get(frame.contentWindow!)! }
function appearance(variant: "dark" | "light") {
  const root = document.documentElement; root.classList.toggle("dark",variant==="dark")
  const built = buildThemeCssVariables({codeThemeId:DEFAULT_THEME_STATE.codeThemeIds[variant],theme:DEFAULT_THEME_STATE.chromeThemes[variant]},variant,{electron:true,isMac:true,systemUiFont:true})
  for (const [key,value] of Object.entries(built.variables)) root.style.setProperty(key,value)
}
function report(value: unknown) { (window as unknown as {webkit:{messageHandlers:{bench:{postMessage:(text:string)=>void}}}}).webkit.messageHandlers.bench.postMessage(JSON.stringify(value)) }
async function screenshot(name: string) {
  await new Promise<void>(resolve => {
    (window as unknown as { __screenshotContinue: () => void }).__screenshotContinue = resolve
    report({ screenshot: name })
  })
}
const surface = () => { const probe = document.createElement("i"); probe.style.cssText = "display:none;background-color:var(--color-background-surface)"; document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color }
let commits = 0
const subscribeTheme = (notify: () => void) => { const observer = new MutationObserver(notify); observer.observe(document.documentElement,{attributes:true,attributeFilter:["class"]}); return () => observer.disconnect() }
const themeSnapshot = () => document.documentElement.classList.contains("dark") ? "dark" as const : "light" as const
const themeValue = (theme: "dark" | "light") => ({ theme, setTheme() {}, translucent: false, setTranslucent() {} })
function Shell({ visual, width, dock = false }: { visual: typeof fixture.visual; width: number; dock?: boolean }) {
  const open = useStore(s => !!s.previews[threadId])
  const theme = useSyncExternalStore(subscribeTheme,themeSnapshot)
  commits++
  return <ThemeProviderContext.Provider value={themeValue(theme)}><div id="stage" className="flex h-[720px] overflow-hidden bg-[var(--color-background-surface)] text-foreground">
    <main id="pane" className="min-w-0 shrink-0 overflow-auto py-6" style={{width}}><VisualReply threadId={threadId} visual={visual} /></main>
    {dock && <aside id="dock" data-overlay={undefined} className="min-w-0 flex-1 border-l border-[color:var(--app-surface-divider)]">{open ? <DockPreviewPane threadId={threadId} active /> : null}</aside>}
  </div></ThemeProviderContext.Provider>
}
/** Mounts a visual and records everything that happens to its box until it settles. */
async function mountVisual(visual: typeof fixture.visual, width: number, dock = false) {
  root.render(null); await sleep(50)
  const trace: {height:number;status:string|null;opacity:string;scheme:string}[] = []
  const sample = () => { const figure = document.querySelector<HTMLElement>("[data-visual-reply]"); if (!figure) return; const frame = figure.querySelector("iframe"); trace.push({height:figure.getBoundingClientRect().height,status:figure.dataset.status??null,opacity:frame?getComputedStyle(frame).opacity:"none",scheme:frame?frame.style.colorScheme:"none"}) }
  flushSync(()=>root.render(<Shell visual={visual} width={width} dock={dock} />))
  const figure = document.querySelector<HTMLElement>("[data-visual-reply]")!
  check(figure,"Figure mounts synchronously")
  const first = figure.getBoundingClientRect().height
  // The box height is set in a frame callback, so a sampling loop that runs first in that frame
  // only sees it a frame later, after the reveal may have started. A resize observer records the
  // new height in the frame that paints it, with the frame's opacity at that moment.
  const resized = new ResizeObserver(sample); resized.observe(figure)
  let stop = false; const loop = () => { sample(); if (!stop) requestAnimationFrame(loop) }; loop()
  await waitFor(()=>figure.dataset.status==="ready"||figure.dataset.status==="error","Visual reaches a final state")
  await sleep(120); stop = true; resized.disconnect(); sample()
  return { figure, first, last: figure.getBoundingClientRect().height, trace, status: figure.dataset.status }
}
const heightsChanged = (trace: {height:number}[]) => trace.reduce((count,entry,index)=>index>0&&Math.abs(entry.height-trace[index-1].height)>=1?count+1:count,0)
async function run() {
  report({stage:"visual-visibility",hidden:document.hidden})
  await waitFor(()=>!document.hidden,"Native visual fixture needs a visible window: unlock macOS and set KYBERN_PERF_FOREGROUND=1")
  report({stage:"visual-connecting"}); await connectFixture(); report({stage:"visual-connected"}); appearance("dark")
  document.body.style.background = "var(--color-background-surface)"
  const measuredHeights = fixture.visual.heights?.length ?? 0
  report({stage:"visual-measured",heights:fixture.visual.heights ?? null,agentHeight:fixture.visual.height})

  // AC 3: with daemon heights the box mounts at its final size at each column width.
  const expected: Record<number, number> = { 736: 210, 520: 340, 375: 420 }
  for (const width of [736,520,375]) {
    const mounted = await mountVisual(fixture.fixed,width)
    check(mounted.status==="ready",`Measured visual loads at ${width}px`)
    if (measuredHeights) {
      check(Math.abs(mounted.first-expected[width])<=1,`Reserved ${mounted.first} at ${width}px, expected ${expected[width]}`)
      check(Math.abs(mounted.first-mounted.last)<=1,`Measured height at ${width}px: mounted ${mounted.first}, settled ${mounted.last}`)
      check(heightsChanged(mounted.trace)===0,`Measured box never changes height at ${width}px`)
    }
    // AC 5 proxy: nothing paints before ready, and the blank canvas stays light-scheme until then.
    check(mounted.trace.every(entry=>entry.status==="ready"||(entry.opacity==="none"||(entry.opacity==="0"&&entry.scheme==="light"))),"Frame stays invisible and light-scheme until ready")
  }
  if (!measuredHeights) report({stage:"visual-warning",message:"No preview browser was available to measure; AC 3 not exercised"})
  // The font-dependent page: report how far Chrome's measurement is from WebKit's layout.
  const realistic = await mountVisual(fixture.visual,736)
  const settledInvisibly = realistic.trace.every((entry,index)=>index===0||Math.abs(entry.height-realistic.trace[index-1].height)<1||entry.opacity==="0")
  report({stage:"visual-measurement-delta",reserved:realistic.first,settled:realistic.last,changes:heightsChanged(realistic.trace),settledInvisibly,...(settledInvisibly ? {} : {trace:realistic.trace.filter((entry,index)=>index===0||JSON.stringify(entry)!==JSON.stringify(realistic.trace[index-1]))})})
  check(settledInvisibly,"A measurement that differs from WebKit's layout settles before the page fades in")
  // Without a preview browser the box starts at the agent's guess, so only a measured page is held to a few pixels.
  if (measuredHeights) check(Math.abs(realistic.first-realistic.last)<=8 && heightsChanged(realistic.trace)<=1,"Chrome's measurement stays within a few pixels of WebKit's layout")
  else check(heightsChanged(realistic.trace)<=1,"An unmeasured page changes height at most once")

  // AC 4: an unmeasured page changes height once, while still invisible; a remount reserves the cached height.
  const first = await mountVisual(fixture.unmeasured,736)
  check(heightsChanged(first.trace)<=1,`Unmeasured box changes height at most once (saw ${heightsChanged(first.trace)})`)
  check(first.trace.every((entry,index)=>index===0||Math.abs(entry.height-first.trace[index-1].height)<1||entry.opacity==="0"),"The one height change happens while the frame is invisible")
  const again = await mountVisual(fixture.unmeasured,736)
  check(Math.abs(again.first-first.last)<0.5 && heightsChanged(again.trace)===0,`Remount reserves the cached height (${again.first} vs ${first.last})`)

  // Main run: measured visual with a dock beside it.
  root.render(null); await sleep(50)
  const mounted = await mountVisual(fixture.visual,736,true)
  const inline = mounted.figure.querySelector("iframe")!, figure = mounted.figure
  const dark = await snapshot(inline)
  check(dark.isolated && dark.image && dark.table===3 && dark.bars===3,"Script, formatted SVG/table, opaque origin and deleted local image render")
  check(dark.background===surface(),`AC 1: the page background (${dark.background}) is the transcript surface (${surface()})`)
  const style = getComputedStyle(figure)
  check(style.borderTopWidth==="0px" && style.backgroundColor==="rgba(0, 0, 0, 0)" && style.borderRadius==="0px","Inline visual has no border, fill or radius")
  check(!document.querySelector("[data-visual-reply] ~ .flex button, [data-visual-reply] + div button"),"No chip row under the visual")
  const open = figure.querySelector<HTMLButtonElement>(".visual-reply__open")!
  check(open && getComputedStyle(open).opacity==="0","Glass button is invisible at rest")
  check(getComputedStyle(open).backdropFilter==="none"||getComputedStyle(open).backdropFilter==="","Resting glass button carries no blur layer")
  probe(inline,"click"); await waitFor(()=>reports.get(inline.contentWindow!)?.counter===1,"Counter is interactive")
  await screenshot("visuals-rest-dark")
  // AC 6: keyboard focus inside the figure reveals the button within 150ms. WebKit only matches
  // :focus-within when the window is key, which an unattended session cannot be: fall back to
  // checking the shipped rule and render the revealed state with an override for the screenshots.
  const windowFocused = document.hasFocus()
  const revealRule = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules] } catch { return [] } }).flatMap(rule => rule instanceof CSSMediaRule ? [...rule.cssRules] : [rule]).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
  const reveals = revealRule.some(rule => rule.selectorText.includes(".visual-reply__open") && rule.selectorText.includes(":focus-within") && rule.style.opacity==="1" && rule.style.getPropertyValue("backdrop-filter").includes("blur"))
  check(reveals,"The shipped stylesheet reveals the glass button on :focus-within and :hover, with the backdrop blur only there")
  const force = document.createElement("style")
  if (windowFocused) {
    open.focus(); await sleep(220)
    check(getComputedStyle(open).opacity==="1","Focus reveals the glass button")
    check(getComputedStyle(open).backdropFilter.includes("blur"),"Revealed glass button blurs its backdrop")
  } else {
    report({stage:"visual-unverified",message:"Window is not key: focus/hover reveal checked by rule inspection only"})
    force.textContent = ".visual-reply .visual-reply__open{opacity:1!important;translate:0 0!important;pointer-events:auto!important;backdrop-filter:blur(12px) saturate(140%)}"
    document.head.append(force); await sleep(220)
  }
  const rect = open.getBoundingClientRect(), box = figure.getBoundingClientRect()
  check(Math.abs(rect.width-28)<1 && Math.abs(box.right-rect.right-8)<1 && Math.abs(rect.top-box.top-8)<1,"Glass button is 28px, 8px from the top-right corner")
  for (const type of ["pointerover","pointerenter","mouseover","mouseenter","pointermove","mousemove"]) open.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type,{bubbles:type!=="pointerenter",pointerType:"mouse",clientX:rect.left+4,clientY:rect.top+4}) : new MouseEvent(type,{bubbles:type!=="mouseenter",clientX:rect.left+4,clientY:rect.top+4}))
  await waitFor(()=>document.querySelector('[data-slot="tooltip-popup"]'),"Tooltip opens",2500).catch(()=>report({stage:"visual-unverified",message:"Tooltip did not open from synthetic pointer events"}))
  const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')
  if (tooltip) { const t = tooltip.getBoundingClientRect(); report({stage:"visual-tooltip",top:t.top,bottom:t.bottom,left:t.left,right:t.right,button:{top:rect.top,bottom:rect.bottom,right:rect.right},box:{left:box.left,right:box.right,bottom:box.bottom}}); check(t.top>=rect.bottom-1 && t.right<=box.right+1 && t.left>=box.left-1,"Tooltip sits below the button inside the frame"); check(t.bottom<=box.bottom+1,"Tooltip stays inside the frame's bounds") }
  await screenshot("visuals-hover-dark")
  const beforeThemeLoads = transport.frameLoads; appearance("light"); await sleep(120)
  const light = await snapshot(inline); check(light.foreground!==dark.foreground && light.background!==dark.background,"Theme follows live without reload")
  check(light.background===surface(),"Light page background is the light surface")
  check(transport.frameLoads===beforeThemeLoads && light.counter===1,"Theme preserves document and counter")
  await screenshot("visuals-hover-light")
  force.remove(); open.blur(); open.dispatchEvent(new MouseEvent("mouseleave")); await sleep(300)
  await screenshot("visuals-rest-light")
  appearance("dark"); await sleep(100)
  document.documentElement.style.setProperty("--color-text-accent","#d43f77"); await sleep(100); check((await snapshot(inline)).accent==="rgb(212, 63, 119)","Custom theme updates chart colors")
  const originalHeight = figure.style.height
  window.postMessage({kind:"kybern-visual-size",height:1900},"*"); await sleep(40); check(figure.style.height===originalHeight,"Other windows cannot spoof height")
  await waitFor(()=>!navigator.userActivation?.isActive,"Native capture activation expires before the untrusted link probe")
  inline.contentWindow!.postMessage({fixture:"kybern-visual-command",action:"spoof-link"},"*"); await sleep(40); check(transport.opened.length===0,"Script cannot open the browser without user activation")

  // AC 13: posted sizes cause no React work after the first content height.
  const commitsBefore = commits
  for (let i = 0; i < 20; i++) { probe(inline,"probe"); await sleep(10) }
  await sleep(120)
  check(commits===commitsBefore,"No Shell render while the page keeps posting")

  // AC 10-12: Open in panel.
  open.focus(); open.click(); await waitFor(()=>document.querySelector("[data-preview-kind=visual] iframe"),"Open in panel shows the Preview content")
  check(useStore.getState().previews[threadId]?.visual.id===fixture.visual.id && useStore.getState().rightTab==="preview" && useStore.getState().rightOpen,"Store opens the dock on the Preview tab")
  const expanded = document.querySelector<HTMLIFrameElement>("[data-preview-kind=visual] iframe")!
  await waitFor(()=>document.querySelector("[data-preview-kind=visual] .visual-reply-panel")?.getAttribute("data-status")==="ready","Panel visual is ready")
  await snapshot(expanded)
  probe(expanded,"click"); await waitFor(()=>reports.get(expanded.contentWindow!)?.counter===1,"Panel page is interactive")
  const gutter = expanded.getBoundingClientRect().left-document.querySelector("[data-preview-kind=visual]")!.getBoundingClientRect().left
  check(Math.abs(gutter-16)<1,`Panel page sits in a 16px gutter (${gutter})`)
  await screenshot("visuals-panel-rendered-dark")
  const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')!
  const loads = transport.frameLoads
  toggle.click(); await waitFor(()=>document.querySelector("[data-visual-source]"),"Source inspection loads")
  const source = document.querySelector<HTMLElement>("[data-visual-source]")!
  check(source.textContent!.includes("data:image/svg+xml;base64,"),"Source embeds the removed image")
  await waitFor(()=>source.dataset.highlighted==="true","Source is highlighted by the worker",6000)
  check(source.querySelectorAll("pre.shiki span").length>20,"Highlighted source contains token spans")
  source.focus(); check(document.activeElement===source,"Source supports keyboard focus")
  await sleep(100); const pausedBefore = await snapshot(expanded); await sleep(150); const pausedAfter = await snapshot(expanded)
  check(pausedAfter.interval===pausedBefore.interval && pausedAfter.raf===pausedBefore.raf && !pausedAfter.visible,"Hidden source pane pauses intervals and frame loops")
  await screenshot("visuals-panel-source-dark")
  document.querySelector<HTMLButtonElement>('[aria-label="Show rendered page"]')!.click(); await sleep(120)
  check(document.querySelector("[data-preview-kind=visual] iframe")===expanded && transport.frameLoads===loads,"Source toggle keeps the same document")
  check((await snapshot(expanded)).counter===1,"Source toggle preserves counter")
  appearance("light"); await sleep(150)
  await screenshot("visuals-panel-rendered-light")
  document.querySelector<HTMLButtonElement>('[aria-label="Show HTML source"]')!.click(); await sleep(250)
  await screenshot("visuals-panel-source-light")
  document.querySelector<HTMLButtonElement>('[aria-label="Show rendered page"]')!.click(); await sleep(150)
  document.querySelector<HTMLButtonElement>('[aria-label="Open in browser"]')!.click(); await waitFor(()=>transport.opened.length===1,"Open in browser forwards a themed URL")
  check(transport.opened[0].includes("/visual-frame/") && transport.opened[0].includes("#kybern-theme="),"Browser URL carries the theme")
  document.querySelector<HTMLButtonElement>('[aria-label="Save HTML"]')!.click(); await waitFor(()=>transport.saved.length===1,"Save forwards the complete durable source"); check(transport.saved[0].name.endsWith(".html") && transport.saved[0].html.includes("data:image/svg+xml;base64,"),"Saved HTML retains embedded images")
  document.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click(); await waitFor(()=>!document.querySelector("[data-preview-kind=visual]"),"Close removes the preview")
  check(!useStore.getState().previews[threadId] && !useStore.getState().rightTabs.includes("preview"),"Close clears the store entry and tab")
  check(document.querySelector("iframe")===inline && (await snapshot(inline)).counter===1,"Closing the panel preserves the inline document")

  const pane = document.getElementById("pane")!; pane.style.opacity="0"; await sleep(100)
  const hiddenBefore = await snapshot(inline); await sleep(150); const hiddenAfter = await snapshot(inline)
  check(hiddenAfter.interval===hiddenBefore.interval && hiddenAfter.raf===hiddenBefore.raf,"Inactive mounted pane pauses page loops")
  probe(inline,"animate"); await sleep(100)
  const lateHidden = await snapshot(inline)
  check(lateHidden.runningAnimations===0 && lateHidden.pausedAnimations===3,"Late CSS and Web Animations pause in an inactive pane")
  pane.style.opacity="1"; await sleep(100); const resumed = await snapshot(inline)
  check(resumed.visible,"Page resumes when pane returns")
  check(resumed.runningAnimations===2 && resumed.pausedAnimations===1,"Visible animations resume while intentional pauses remain")
  pane.style.width="360px"; await sleep(100); check(inline.getBoundingClientRect().width<=360,"Responsive narrow layout")
  await screenshot("visuals-narrow-light")

  // AC 9: a consumed or expired ticket becomes Retry, never the daemon's 404 text.
  appearance("dark"); transport.expireNext = 1
  root.render(null); await sleep(50)
  flushSync(()=>root.render(<Shell visual={fixture.visual} width={736} />))
  const failing = document.querySelector<HTMLElement>("[data-visual-reply]")!
  await waitFor(()=>failing.querySelector(".visual-reply__error"),"Expired ticket shows the error state within the watchdog window",7000)
  const errorBox = failing.querySelector<HTMLElement>(".visual-reply__error")!
  check(errorBox.textContent!.includes("Couldn’t load") && errorBox.textContent!.includes("Retry") && !failing.textContent!.includes("expired"),"Error offers Retry and hides the 404 text")
  check(getComputedStyle(failing.querySelector("iframe")!).opacity==="0","The 404 document stays invisible")
  check(!failing.querySelector(".visual-reply__open"),"No glass button in the error state")
  await screenshot("visuals-error-dark")
  const mintsBefore = transport.mints;
  [...errorBox.querySelectorAll("button")].find(item=>item.textContent==="Retry")!.click()
  await waitFor(()=>failing.dataset.status==="ready","Retry mints a new ticket and renders the page")
  check(transport.mints===mintsBefore+1,"Retry mints exactly one new ticket")

  // AC 8: the skeleton shows only after 200ms and animates opacity only.
  transport.mintDelay = 900
  root.render(null); await sleep(50)
  flushSync(()=>root.render(<Shell visual={fixture.unmeasured} width={736} />))
  const loading = document.querySelector<HTMLElement>("[data-visual-reply]")!
  await sleep(80); check(!loading.querySelector(".visual-reply__skeleton"),"No skeleton before 200ms")
  await waitFor(()=>loading.querySelector(".visual-reply__skeleton"),"Skeleton appears after the delay",1000)
  const skeleton = loading.querySelector<HTMLElement>(".visual-reply__skeleton")!
  // Reduced motion (a runner setting) turns the breathing off; otherwise it is the only animation.
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
  const skeletonAnimation = getComputedStyle(skeleton).animationName
  const skeletonAnimations = skeleton.getAnimations().map(animation=>(animation as CSSAnimation).animationName ?? animation.constructor.name)
  check(reducedMotion ? skeletonAnimation==="none" && skeletonAnimations.length===0 : skeletonAnimation==="visual-skeleton-breathe" && skeletonAnimations.every(name=>name==="visual-skeleton-breathe"),`Skeleton breathes with the opacity-only keyframes ${JSON.stringify({reducedMotion,skeletonAnimation,skeletonAnimations})}`)
  await sleep(100); await screenshot("visuals-loading-dark")
  await waitFor(()=>loading.dataset.status==="ready","Delayed visual loads"); check(!loading.querySelector(".visual-reply__skeleton"),"Skeleton unmounts when ready")
  transport.mintDelay = 0
  root.unmount(); closeFixture(); report({pass:true,measuredHeights:measuredHeights>0,opaqueScript:true,formattedTable:true,svgChart:true,durableEmbeddedImage:true,liveTheme:true,panelSource:true,hiddenPause:true,lateAnimations:true,narrowLayout:true,errorRetry:true})
}
run().catch(error=>{closeFixture();report({pass:false,error:String(error)})})
