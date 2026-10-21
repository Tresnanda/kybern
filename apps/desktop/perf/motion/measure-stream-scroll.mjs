// Streaming + scrolling workload on the long thread: frame intervals, long tasks and the peak
// number of running animations, for one frontend (VITE_PORT) at a time.
//   LONG=<thread id> VITE_PORT=5368 node measure-stream-scroll.mjs  [label]
import { execFileSync } from "node:child_process"
import { open, thread, frames, runningAnimations, DATA } from "./probe-lib.mjs"
const KYBERN = process.env.KYBERN_CLI || "/Applications/kybern.app/Contents/MacOS/kybern"
const k = (...a) => execFileSync(KYBERN, ["--data-dir", DATA, ...a], { encoding: "utf8" })
const long = process.env.LONG
const label = process.argv[2] || `port-${process.env.VITE_PORT}`
const { browser, page } = await open({ scheme: "dark", scale: 1 })
await thread(page, process.env.LONG_TITLE || "Measure streaming")
await page.waitForTimeout(1500)
k("send", long, "--detach", "SCENE_STREAM measure")
await page.waitForTimeout(2500) // the stream is under way
const result = { label }
result.streaming = await frames(page, async () => {}, { ms: 6000 })
result.scrolling = await frames(page, async () => {
  await page.mouse.move(900, 450)
  for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, i % 2 ? 380 : -380); await page.waitForTimeout(180) }
}, { ms: 800 })
result.animationsAtEnd = (await runningAnimations(page)).length
result.loopsAtEnd = (await runningAnimations(page, { loopsOnly: true })).length
console.log(JSON.stringify(result))
k("interrupt", long)
await browser.close()
