import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { pathToFileURL } from "node:url"
const [repo, data, log] = process.argv.slice(2)
const { KybernClient } = await import(
  pathToFileURL(repo + "/packages/kybern-client/src/client.ts")
)
const port = readFileSync(data + "/daemon.port", "utf8").trim()
const client = new KybernClient({
  url: `ws://127.0.0.1:${port}/ws`,
  token: readFileSync(data + "/daemon.token", "utf8").trim(),
})
const thread_id = JSON.parse(readFileSync(data + "/fixture.json")).thread_id
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function phase(name) {
  writeFileSync(data + "/phase.tmp", name)
  renameSync(data + "/phase.tmp", data + "/phase")
}
const results = []
await new Promise((resolve, reject) => {
  client.onStatus((s, d) => {
    if (s === "open") resolve()
    if (s === "failed") reject(new Error(d))
  })
  client.connect()
})
try {
  phase("initial-idle")
  await wait(5000)
  phase("recent-page")
  let snapshot
  for (let n = 0; n < 5; n++) {
    const t = performance.now()
    snapshot = await client.call("threads.get", {
      thread_id,
      transcript_limit: 60,
      include_tool_output: false,
    })
    results.push({
      stage: "recent-page",
      n,
      ms: performance.now() - t,
      rows: snapshot.transcript.length,
    })
  }
  phase("history-pages")
  let cursor = snapshot.next_before_seq
  for (let n = 0; n < 12 && cursor != null; n++) {
    const t = performance.now()
    const r = await client.call("threads.get", {
      thread_id,
      transcript_limit: 120,
      before_seq: cursor,
      through_seq: snapshot.thread.last_seq,
      include_tool_output: false,
    })
    cursor = r.next_before_seq
    results.push({
      stage: "history-page",
      n,
      ms: performance.now() - t,
      rows: r.transcript.length,
    })
  }
  phase("large-results")
  for (let n = 0; n < 3; n++) {
    const t = performance.now()
    const r = await client.call("threads.get", {
      thread_id,
      transcript_limit: 120,
    })
    results.push({
      stage: "full-page",
      n,
      ms: performance.now() - t,
      rows: r.transcript.length,
    })
  }
  phase("replay")
  let count = 0,
    last = 0
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("replay timeout")), 30000)
    client.subscribeEvents(
      { thread_id, after_seq: 0 },
      (e) => {
        if (e.seq <= last) reject(new Error("replay order"))
        last = e.seq
        count++
      },
      undefined,
      () => {
        clearTimeout(timer)
        resolve()
      }
    )
  })
  results.push({ stage: "replay", count, last })
  phase("terminal")
  let output = ""
  client.onNotification("terminal.output", (p) => {
    output += Buffer.from(p.data, "base64").toString()
  })
  const term = await client.call("terminals.create", {
    thread_id,
    command: [
      "/bin/sh",
      "-c",
      'for i in $(seq 1 5000); do echo "terminal line $i"; done; sleep 1',
    ],
  })
  await client.call("terminals.subscribe", {
    terminal_id: term.id,
    replay: true,
  })
  await wait(2000)
  if (!output.includes("terminal line 5000"))
    throw new Error("terminal output missing")
  await client.call("terminals.close", { terminal_id: term.id })
  results.push({ stage: "terminal", lastLine: true })
  phase("post-workload-idle")
  await wait(10000)
  writeFileSync(log, JSON.stringify(results, null, 2))
} finally {
  client.close()
}
