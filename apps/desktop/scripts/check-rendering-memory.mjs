// Exercise rendered history as well as the store/worker-only memory fixture.
// vmmap's process footprint includes graphics allocations; DOM counts do not.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

// Keep the reproduced history regression below 768 MiB. The later 800-tool
// workloads have a separate 1 GiB guard; neither is a whole-app RAM guarantee.
const historyLimitMiB = 768
const limitMiB = 1024
const child = spawn(process.execPath, [fileURLToPath(new URL("./check-rendering.mjs", import.meta.url)), "scrolling"], {
  env: { ...process.env, KYBERN_SCROLL_MEMORY: "1" },
  stdio: ["ignore", "pipe", "inherit"],
})
const completion = new Promise((resolve, reject) => {
  child.on("error", reject)
  child.on("close", (code) => resolve(code ?? 1))
})
const samples = []
for await (const line of createInterface({ input: child.stdout })) {
  console.log(line)
  if (!line.startsWith("{")) continue
  const record = JSON.parse(line)
  if (!record.footprint) continue
  const match = /Physical footprint \(peak\):\s*([\d.]+)([KMG])/.exec(record.peak ?? "")
  if (!match) throw new Error(`Missing native peak footprint at ${record.sample}`)
  samples.push({ stage: record.sample, peakMiB: Number(match[1]) * { K: 1 / 1024, M: 1, G: 1024 }[match[2]] })
}
const status = await completion
const peakMiB = Math.max(0, ...samples.map(sample => sample.peakMiB))
const history = samples.filter(sample => sample.stage.startsWith("history-"))
const historyPeakMiB = Math.max(0, ...history.map(sample => sample.peakMiB))
const memoryPass = history.length > 0 && historyPeakMiB <= historyLimitMiB && peakMiB <= limitMiB
const renderingPass = status === 0
const pass = renderingPass && memoryPass
console.log(JSON.stringify({ fixture: "rendered-history-memory", samples: samples.length, historyPeakMiB, historyLimitMiB, peakMiB, limitMiB, memoryPass, renderingPass, pass }))
process.exitCode = pass ? 0 : 1
