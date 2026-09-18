import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { assistantCommonPrefix } from "../../../packages/kybern-client/src/transcript.ts"

const mode = process.argv[2]
if (!mode) {
  for (const candidate of ["baseline", "candidate"]) {
    const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), candidate], {
      encoding: "utf8",
      env: process.env,
    })
    if (run.status !== 0) {
      process.stderr.write(run.stderr)
      process.exit(run.status ?? 1)
    }
    process.stdout.write(run.stdout)
  }
  process.exit(0)
}

const length = Number(process.env.KYBERN_ASSISTANT_SETTLEMENT_CHARS ?? 8_000_000)
const pieces = ["a".repeat(length), "\ud83d", "\ude00old"]
const canonical = `${"a".repeat(length)}\ud83d\ude01new`

function baselineCommonPrefix() {
  const streamed = pieces.join("")
  if (streamed === canonical) return streamed.length
  let prefix = 0
  const streamedChars = Array.from(streamed)
  const canonicalChars = Array.from(canonical)
  for (let position = 0; position < streamedChars.length; position++) {
    if (streamedChars[position] !== canonicalChars[position]) break
    prefix += streamedChars[position].length
  }
  return prefix
}

if (typeof global.gc !== "function") throw new Error("Run this fixture with --expose-gc")
global.gc()
const before = process.memoryUsage()
const commonPrefix = mode === "baseline"
  ? baselineCommonPrefix()
  : assistantCommonPrefix(pieces, canonical).commonPrefix
const after = process.memoryUsage()
if (commonPrefix !== length) throw new Error(`Incorrect prefix: ${commonPrefix}`)
console.log(JSON.stringify({
  mode,
  characters: length,
  exactCanonicalLength: canonical.length,
  heapDeltaMiB: (after.heapUsed - before.heapUsed) / 1024 / 1024,
  maxRssMiB: process.resourceUsage().maxRSS / 1024,
}))
