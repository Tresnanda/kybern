import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { visualHeight, visualLink, visualFileName, visualThemeFragment, visualMeasuredHeight, visualFrameHeight, readVisualHeights, clampVisualHeight } from "../../packages/kybern-client/src/visuals.ts"
import { applyEvent, emptyThreadState, seedFromGet, createTurnGrouper } from "../../packages/kybern-client/src/transcript.ts"
const visual = { id: "visual-1", title: "Comparison chart", height: 400 }
const event = (seq, kind, payload = {}, turn_id = "turn-1") => ({ seq, kind, thread_id: "thread-1", turn_id, at: "2026-10-07T00:00:00Z", ...payload })
test("published visuals survive live settlement and transcript reload without entering work", () => {
  const group = createTurnGrouper()
  let state = applyEvent(emptyThreadState(), event(1,"turn_started", { message_id:"user-1", message:{content:[{type:"text",text:"Show a chart"}]} }))
  state = applyEvent(state,event(2,"html_published", {visual}))
  const published = state.blocks.find(block => block.kind === "visual")
  assert.equal(group(state.blocks)[0].visuals[0],published)
  state = applyEvent(state,event(3,"html_published", {visual}))
  assert.equal(state.blocks.filter(block => block.kind === "visual").length,1)
  state = applyEvent(state,event(4,"turn_completed", {stop_reason:"completed",usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0},duration_ms:400,terminal_message_id:null}))
  assert.equal(group(state.blocks)[0].visuals[0],published)
  assert.ok(!group(state.blocks)[0].work.some(block => block.kind === "visual"))
  const reloaded = seedFromGet({thread:{id:"thread-1",last_seq:4},transcript:[{role:"visual",turn_id:"turn-1",seq:2,at:event(2).at,visual}],pending_approvals:[],checkpoints:[]})
  assert.deepEqual(group(reloaded.blocks)[0].visuals[0].visual,visual)
})
test("streaming a later turn preserves settled visual group identity", () => {
  const group = createTurnGrouper()
  let state = applyEvent(emptyThreadState(),event(1,"html_published",{visual}))
  state = applyEvent(state,event(2,"turn_completed",{stop_reason:"completed",usage:{},duration_ms:0,terminal_message_id:null}))
  const settled = group(state.blocks)[0]
  state = applyEvent(state,event(3,"turn_started",{message_id:"user-2",message:{content:[]}},"turn-2"))
  state = applyEvent(state,event(4,"assistant_text_delta",{message_id:"answer-2",origin:{kind:"root"},delta:"Next"},"turn-2"))
  assert.equal(group(state.blocks)[0],settled)
})
test("frame messages clamp size and reject executable, credentialed or oversized URLs", () => {
  assert.equal(visualHeight(140.4,400),141)
  assert.equal(visualHeight(99999999,400),400)
  for (const value of [NaN, Infinity, -1, "400", null, {}]) assert.equal(visualHeight(value,400),null)
  for (const value of ["javascript:alert(1)","file:///etc/passwd","https://user:password@example.test","https://example.test/"+"a".repeat(5000),{}]) assert.equal(visualLink(value),null)
  assert.equal(visualLink("https://example.test/docs"),"https://example.test/docs")
})
test("save names and first-paint theme are portable", () => {
  assert.equal(visualFileName('Chart / Q4:*?'),"Chart Q4.html")
  const theme = {appearance:"light",variables:{"--foreground":"#222","--font-sans":"system-ui"}}
  const fragment = visualThemeFragment(theme)
  assert.deepEqual(JSON.parse(decodeURIComponent(fragment.split("=")[1])),theme)
})

test("hidden visual animations pause on late starts and resume only the page's running choices", () => {
  const listeners = new Map(), animations = [], styles = []
  class Animation {
    constructor(state = "running") { this.playState = state }
    pause() { this.playState = "paused" }
    play() { this.playState = "running" }
    cancel() { this.playState = "idle" }
    finish() { this.playState = "finished" }
    reverse() { this.playState = "running" }
  }
  class CSSAnimation extends Animation {}
  class Element {
    animate() { const animation = new Animation(); animations.push(animation); return animation }
  }
  const document = {
    documentElement: { dataset: {} },
    getElementById: () => ({ textContent: "" }),
    createElement: () => ({ textContent: "" }),
    head: { appendChild: style => styles.push(style) },
    getAnimations: () => animations,
    querySelectorAll: () => [],
    addEventListener: () => {},
  }
  const window = {
    parent: {}, Animation, CSSAnimation, Element,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    setInterval: () => 2, clearInterval: () => {},
    addEventListener: (kind, callback) => listeners.set(kind, callback),
    dispatchEvent: () => {},
  }
  runInNewContext(readFileSync(new URL("../../crates/kybern-daemon/src/visuals/bootstrap.js", import.meta.url), "utf8"), {
    document, window, location: { hash: "" }, ResizeObserver: class { observe() {} }, CustomEvent: class {},
  })
  const visible = value => listeners.get("message")({ source: window.parent, data: { kind: "kybern-visual-host", visible: value } })
  const running = new Element().animate(), intentionallyPaused = new Element().animate()
  intentionallyPaused.pause()
  visible(false)
  assert.equal(running.playState, "paused")
  assert.equal(document.documentElement.dataset.kybernActive, "false")
  assert.match(styles[0].textContent, /html\[data-kybern-active="false"\].*animation-play-state:paused!important/, "a persistent CSS gate covers keyframes created after hiding")
  assert.ok(styles[0].textContent.includes('*::before') && styles[0].textContent.includes('*::after'), "CSS loader pseudo-elements use the same hidden gate")
  const late = new Element().animate()
  assert.equal(late.playState, "paused", "Element.animate cannot start an offscreen loop")
  const direct = new Animation("idle"); animations.push(direct); direct.play()
  assert.equal(direct.playState, "paused", "direct Web Animations starts also pause")
  const bypassed = new Animation(); animations.push(bypassed)
  visible(false)
  assert.equal(bypassed.playState, "paused", "a repeated hidden message enforces pause")
  late.pause()
  direct.cancel()
  const finished = new Element().animate(); finished.finish()
  visible(true)
  assert.equal(running.playState, "running")
  assert.equal(bypassed.playState, "running")
  assert.equal(intentionallyPaused.playState, "paused", "preexisting paused state survives")
  assert.equal(late.playState, "paused", "explicit pause while hidden remains paused")
  assert.equal(direct.playState, "idle", "canceled work never resumes")
  assert.equal(finished.playState, "finished", "finished work never resumes")
})

const measured = [{width:320,height:900},{width:375,height:800},{width:736,height:400},{width:1152,height:300}]
test("measured heights take the taller neighbour between widths and clamp at the ends", () => {
  assert.equal(visualMeasuredHeight(measured,375),800)
  assert.equal(visualMeasuredHeight(measured,500),800, "between 375 and 736 the taller of both")
  assert.equal(visualMeasuredHeight(measured,900),400, "between 736 and 1152")
  assert.equal(visualMeasuredHeight(measured,100),900, "below the narrowest measurement")
  assert.equal(visualMeasuredHeight(measured,5000),400, "above the widest measurement: the last two widths")
})
test("frame height prefers the page, then the measurement, and caps only when the agent asked to scroll", () => {
  const visual = {id:"v",title:"t",height:1000,heights:measured}
  assert.equal(visualFrameHeight(visual,736,350),350, "posted content height wins")
  assert.equal(visualFrameHeight(visual,375),800, "measured at this width")
  assert.equal(visualFrameHeight({...visual,height:300},736),300, "agent cap below the measured column height")
  assert.equal(visualFrameHeight({...visual,height:500},736),400, "agent cap above the measured column height does not apply")
  assert.equal(visualFrameHeight({id:"v",title:"t",height:400},736,650),400, "unmeasured: min(agent, content)")
  assert.equal(visualFrameHeight({id:"v",title:"t",height:400},736),400)
  assert.equal(visualFrameHeight({id:"v",title:"t",height:400,heights:[]},736,120),120)
  assert.equal(visualFrameHeight(visual,736,5),80); assert.equal(visualFrameHeight(visual,736,99999),2000)
  assert.equal(clampVisualHeight(1.4),80)
})
test("reading measured heights rejects malformed lists and sorts valid ones", () => {
  assert.deepEqual(readVisualHeights([{width:640,height:200},{width:320,height:900}]),[{width:320,height:900},{width:640,height:200}])
  assert.equal(readVisualHeights(Array.from({length:25},(_,i)=>({width:i+1,height:100}))),undefined)
  assert.equal(readVisualHeights([{width:320.5,height:100}]),undefined)
  assert.equal(readVisualHeights([{width:320,height:"100"}]),undefined)
  assert.equal(readVisualHeights([]),undefined); assert.equal(readVisualHeights(null),undefined)
})
test("published visuals keep their measured heights through events and reload, and old events still group", () => {
  const group = createTurnGrouper(), withHeights = {...visual,heights:measured}
  let state = applyEvent(emptyThreadState(),event(1,"html_published",{visual:withHeights}))
  assert.deepEqual(state.blocks.find(block => block.kind === "visual").visual.heights,measured)
  const reloaded = seedFromGet({thread:{id:"thread-1",last_seq:1},transcript:[{role:"visual",turn_id:"turn-1",seq:1,at:event(1).at,visual:withHeights}],pending_approvals:[],checkpoints:[]})
  assert.deepEqual(group(reloaded.blocks)[0].visuals[0].visual.heights,measured)
  const old = applyEvent(emptyThreadState(),event(1,"html_published",{visual}))
  assert.equal(group(old.blocks)[0].visuals[0].visual.heights,undefined)
})
function bootstrap(parent) {
  const messages = [], listeners = new Map()
  const window = { parent: parent ?? null, postMessage: message => messages.push(message), requestAnimationFrame: callback => { callback(0); return 1 }, cancelAnimationFrame() {}, setInterval: () => 2, clearInterval() {}, addEventListener() {}, dispatchEvent() {} }
  if (!parent) window.parent = window; else parent.postMessage = message => messages.push(message)
  const document = { documentElement: { dataset: {} }, body: { scrollHeight: 10, getBoundingClientRect: () => ({ height: 10 }) }, getElementById: () => ({ textContent: "" }), createElement: () => ({ textContent: "" }), head: { appendChild() {} }, getAnimations: () => [], querySelectorAll: () => [], addEventListener: (kind, callback) => listeners.set(kind, callback) }
  runInNewContext(readFileSync(new URL("../../crates/kybern-daemon/src/visuals/bootstrap.js", import.meta.url), "utf8"), { document, window, location: { hash: "" }, ResizeObserver: class { observe() {} }, CustomEvent: class {} })
  listeners.get("DOMContentLoaded")()
  return messages
}
test("a framed page announces readiness once and a top-level page stays silent", () => {
  const framed = bootstrap({}), ready = framed.filter(message => message.kind === "kybern-visual-ready")
  assert.equal(ready.length,1)
  assert.ok(framed.some(message => message.kind === "kybern-visual-size"))
  assert.ok(!bootstrap(null).some(message => message.kind === "kybern-visual-ready"))
})
