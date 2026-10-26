// Memory log: one JSON line a minute in the client's local data folder
// (`memory.jsonl`, under 4 MiB with one rotated copy; `%LOCALAPPDATA%` on Windows), so a footprint spike in
// a real session can be traced to what was open when it happened. Each line has
// the physical footprint (Activity Monitor's number), JSC's heap and allocator
// counters, every pane's thread and transcript size, and the steps since the
// previous line (`startupMark` phases: thread opens, history pages). Cheap by
// design: allocator counters and one `proc_pid_rusage` call per sample. A heap
// census (object types, a full heap walk) runs only after a jump of
// CENSUS_JUMP_MB, at most once every CENSUS_GAP_MS. `KYBERN_MEMORY_LOG=0` turns
// it off; `KYBERN_MEMORY_LOG_MS` changes the interval.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { heapStats, memoryUsage } from 'bun:jsc'
import { desktopVersion } from '../shell/daemon.ts'
import { gpuixLocalDir } from '../platform/os.ts'

const MB = 1024 * 1024
const MAX_FILE = 4 * MB
const CENSUS_JUMP_MB = 96
const CENSUS_GAP_MS = 15 * 60_000
const STEP_LIMIT = 64

type Context = () => unknown
const contexts = new Map<string, Context>()
/** Add a named part to every line (open panes, dock, caches). */
export function addMemoryContext(name: string, read: Context) { contexts.set(name, read) }

const steps: unknown[] = []
/** Remember a step for the next line; the oldest drop once STEP_LIMIT are waiting. */
export function memoryStep(phase: string, detail?: Record<string, unknown>) {
  if (!started) return
  steps.push({ phase, at: Date.now(), ...detail })
  if (steps.length > STEP_LIMIT) steps.shift()
}

let rusage: ((pid: number, flavor: number, buffer: number) => number) | null | undefined
const usage = new BigUint64Array(12)
/** `ri_phys_footprint` from `rusage_info_v0`, in bytes; `null` off macOS. */
function footprint(): number | null {
  if (rusage === undefined) {
    try {
      rusage = dlopen('/usr/lib/libSystem.B.dylib', { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } }).symbols.proc_pid_rusage as never
    } catch { rusage = null }
  }
  // v0 layout: uuid (16 bytes), then user/system time, wakeups ×2, pageins, wired, resident, phys_footprint.
  return rusage && rusage(process.pid, 0, ptr(usage) as never) === 0 ? Number(usage[9]) : null
}

function version() { try { return desktopVersion() } catch { return null } }

const mb = (bytes: number) => Math.round(bytes / MB * 10) / 10

function census() {
  const stats = heapStats()
  const top = Object.entries(stats.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 24)
  return { objects: stats.objectCount, protected: stats.protectedObjectCount, extraMb: mb(stats.extraMemorySize), types: Object.fromEntries(top) }
}

let started = false
let file = ''
let lastJs = 0
let lastCensus = 0
let peak = 0

function write(line: Record<string, unknown>) {
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_FILE) renameSync(file, `${file}.1`)
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  } catch { /* A full or read-only disk loses the line, never the app. */ }
}

export function sampleMemory(reason = 'tick') {
  const process_ = process.memoryUsage()
  const jsc = memoryUsage()
  const phys = footprint()
  if (phys != null) peak = Math.max(peak, phys)
  const line: Record<string, unknown> = {
    at: new Date().toISOString(), reason,
    footprintMb: phys == null ? null : mb(phys), peakMb: mb(peak), rssMb: mb(process_.rss),
    js: { heapMb: mb(process_.heapUsed), capacityMb: mb(process_.heapTotal), externalMb: mb(process_.external), arrayBuffersMb: mb(process_.arrayBuffers) },
    allocator: { currentMb: mb(jsc.current), peakMb: mb(jsc.peak), commitMb: mb(jsc.currentCommit), peakCommitMb: mb(jsc.peakCommit) },
  }
  for (const [name, read] of contexts) {
    try { line[name] = read() } catch (error) { line[name] = { error: String(error) } }
  }
  if (steps.length) line.steps = steps.splice(0)
  const now = Date.now()
  if (process_.heapUsed - lastJs > CENSUS_JUMP_MB * MB && now - lastCensus > CENSUS_GAP_MS) {
    lastCensus = now
    line.census = census()
  }
  lastJs = process_.heapUsed
  write(line)
  return line
}

/** Start the minute samples; a no-op when turned off or already running. */
export function startMemoryLog() {
  if (started || process.env.KYBERN_MEMORY_LOG === '0') return
  started = true
  const dir = gpuixLocalDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* `write` reports nothing either. */ }
  file = path.join(dir, 'memory.jsonl')
  write({ at: new Date().toISOString(), reason: 'launch', pid: process.pid, version: version() })
  const interval = Number(process.env.KYBERN_MEMORY_LOG_MS) || 60_000
  setInterval(() => sampleMemory(), interval).unref()
}
