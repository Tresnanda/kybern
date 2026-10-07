import assert from "node:assert/strict"
import test from "node:test"
import { visualHeight, visualLink, visualFileName, visualThemeFragment } from "../../packages/kybern-client/src/visuals.ts"
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
