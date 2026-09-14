type BenchWindow = Window & {
  webkit: {
    messageHandlers: { bench: { postMessage: (value: string) => void } }
  }
}

const nativeWorker = globalThis.Worker
let constructed = 0
let active = 0
let terminated = 0

// Install the probe before either production module is evaluated. Returning a
// proxied native worker keeps Worker API calls branded while allowing the
// fixture to observe the actual constructors and idle-release terminations.
const countingWorker = new Proxy(nativeWorker, {
  construct(target, args) {
    const worker = Reflect.construct(target, args) as Worker
    constructed++
    active++
    let released = false
    const terminate = () => {
      if (!released) {
        released = true
        active--
        terminated++
      }
      return worker.terminate()
    }
    return new Proxy(worker, {
      get(targetWorker, property) {
        if (property === "terminate") return terminate
        const value = Reflect.get(targetWorker, property, targetWorker)
        return typeof value === "function" ? value.bind(targetWorker) : value
      },
      set(targetWorker, property, value) {
        return Reflect.set(targetWorker, property, value, targetWorker)
      },
    })
  },
})
globalThis.Worker = countingWorker

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const postJSON = (value: unknown) =>
  (window as BenchWindow).webkit.messageHandlers.bench.postMessage(
    JSON.stringify(value)
  )
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function hasNode(
  value: unknown,
  predicate: (node: Record<string, unknown>) => boolean
): boolean {
  if (Array.isArray(value))
    return value.some((child) => hasNode(child, predicate))
  if (!value || typeof value !== "object") return false
  const node = value as Record<string, unknown>
  if (predicate(node)) return true
  const children = node.children
  return (
    Array.isArray(children) &&
    children.some((child) => hasNode(child, predicate))
  )
}

function hasElement(value: unknown, tagName: string): boolean {
  return hasNode(
    value,
    (node) => node.type === "element" && node.tagName === tagName
  )
}

function hasText(value: unknown, text: string): boolean {
  return hasNode(
    value,
    (node) =>
      node.type === "text" &&
      typeof node.value === "string" &&
      node.value.includes(text)
  )
}

function checkHighlight(
  html: string | null,
  source: string,
  label: string
): asserts html is string {
  check(html !== null && html.includes("<span"), `${label} was not formatted`)
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const code = parsed.querySelector("pre > code")
  check(
    code !== null && code.textContent === source,
    `${label} changed or truncated source text`
  )
}

async function waitForIdleRelease(
  idleMs: number,
  graceMs: number,
  label: string
) {
  await sleep(idleMs + graceMs)
  check(active === 0, `${label} workers remained active: ${active}`)
}

async function run() {
  // These values mirror the production fallback and the diagnostic override
  // used by the parent native run, while still making an accidental default
  // visible in the report.
  const configuredIdleMs = Number(import.meta.env.VITE_KYBERN_WORKER_IDLE_MS)
  const idleMs =
    Number.isFinite(configuredIdleMs) && configuredIdleMs >= 0
      ? configuredIdleMs
      : 30_000
  const graceMs = 500
  const markdown = await import("../src/lib/markdown")
  const { highlightToHtml } = await import("../src/lib/highlight")

  const beforeQueueAbort = new AbortController()
  beforeQueueAbort.abort()
  const canceledBeforeQueue = await highlightToHtml(
    "const canceled = true",
    "typescript",
    true,
    { signal: beforeQueueAbort.signal }
  )
  check(
    canceledBeforeQueue === null,
    "Pre-queue highlight cancellation returned output"
  )
  check(
    constructed === 0,
    `Pre-queue cancellation constructed ${constructed} workers`
  )

  const cancellationConsumer = markdown.nextMarkdownConsumer()
  const activeRequest = markdown.parseMarkdown(
    {
      consumer: cancellationConsumer,
      source: "# Queue active\n\nThis request is allowed to finish.",
      baseRevision: 0,
    },
    new AbortController().signal
  )
  const queuedAbort = new AbortController()
  const queuedRequest = markdown.parseMarkdown(
    {
      consumer: markdown.nextMarkdownConsumer(),
      source: "# Queue canceled\n\nThis request must never reach the worker.",
      baseRevision: 0,
    },
    queuedAbort.signal
  )
  queuedAbort.abort()
  check(
    (await queuedRequest) === null,
    "Queued Markdown cancellation did not resolve null"
  )
  const activeReply = await activeRequest
  check(
    activeReply !== null && activeReply.blocks.length > 0,
    "Active Markdown request failed during cancellation check"
  )

  const markdownSource = [
    "# Worker lifecycle",
    "",
    "Preserve **formatted** output with `inline code`.",
    "",
    "```typescript",
    "const warmValue: number = 42",
    "```",
  ].join("\n")
  const markdownConsumer = markdown.nextMarkdownConsumer()
  const warmReply = await markdown.parseMarkdown(
    { consumer: markdownConsumer, source: markdownSource, baseRevision: 0 },
    new AbortController().signal
  )
  check(warmReply !== null, "Warm Markdown parse returned no reply")
  check(
    warmReply.prefix === 0 && warmReply.blocks.length >= 3,
    "Warm Markdown parse was not a full revision"
  )
  const warmNodes = warmReply.blocks.map(({ node }) => node)
  check(
    hasElement(warmNodes, "h1") &&
      hasElement(warmNodes, "strong") &&
      hasElement(warmNodes, "pre"),
    "Warm Markdown lost formatted elements"
  )
  check(
    hasText(warmNodes, "Worker lifecycle") &&
      hasText(warmNodes, "warmValue: number = 42"),
    "Warm Markdown lost exact text"
  )
  const cachedResult = { source: markdownSource, blocks: warmReply.blocks }
  markdown.cacheMarkdown(cachedResult)

  const warmCode = "const warmValue: number = 42"
  const warmHighlight = await highlightToHtml(warmCode, "typescript", true)
  checkHighlight(warmHighlight, warmCode, "Warm highlighting")
  const warmConstructed = constructed
  check(
    warmConstructed === 2,
    `Expected one Markdown and one highlight worker, saw ${warmConstructed}`
  )

  await waitForIdleRelease(idleMs, graceMs, "Initial idle release")
  const workersAtIdle = { constructed, active, terminated }
  check(
    constructed === 2 && active === 0,
    `Initial idle release expected constructed=2 active=0, saw ${constructed}/${active}`
  )

  const cachedAgain = markdown.cachedMarkdown(markdownSource)
  check(
    cachedAgain === cachedResult,
    "Settled Markdown cache did not return the same parsed result"
  )
  const cachedHighlight = await highlightToHtml(warmCode, "typescript", true)
  check(
    cachedHighlight === warmHighlight,
    "Settled highlight cache did not return exact HTML"
  )
  check(
    constructed === 2 && active === 0,
    `Warm cache revisit constructed workers: ${constructed} (active ${active})`
  )

  const coldMarkdownSource = `${markdownSource}\n\n## Cold revision\n\n**Full revision after worker release.**`
  const coldReply = await markdown.parseMarkdown(
    {
      consumer: markdownConsumer,
      source: coldMarkdownSource,
      baseRevision: warmReply.revision,
    },
    new AbortController().signal
  )
  check(coldReply !== null, "Cold Markdown parse returned no reply")
  check(
    coldReply.prefix === 0,
    `Restarted Markdown worker returned a partial prefix: ${coldReply.prefix}`
  )
  check(
    coldReply.blocks.length > warmReply.blocks.length,
    "Restarted Markdown worker did not return the full revision"
  )
  const coldNodes = coldReply.blocks.map(({ node }) => node)
  check(
    hasElement(coldNodes, "h2") && hasElement(coldNodes, "strong"),
    "Restarted Markdown lost formatted output"
  )
  check(
    hasText(coldNodes, "Cold revision") &&
      hasText(coldNodes, "Full revision after worker release."),
    "Restarted Markdown lost exact text"
  )
  check(
    constructed === 3,
    `Cold Markdown input did not recreate exactly one worker: ${constructed}`
  )

  const coldCode = "const coldValue: number = 99"
  const coldHighlight = await highlightToHtml(coldCode, "typescript", true)
  checkHighlight(coldHighlight, coldCode, "Cold highlighting")
  check(
    constructed === 4,
    `Cold highlight input did not recreate exactly one worker: ${constructed}`
  )
  const coldHighlightAgain = await highlightToHtml(coldCode, "typescript", true)
  check(
    coldHighlightAgain === coldHighlight,
    "Cold highlight cache did not preserve exact HTML"
  )

  await waitForIdleRelease(idleMs, graceMs, "Restarted idle release")
  check(active === 0, `Restarted idle release left ${active} active workers`)
  postJSON({
    pass: true,
    fixture: "worker-lifecycle",
    idleMs,
    graceMs,
    workersAtIdle,
    constructed,
    active,
    terminated,
    warmCacheReuse: { markdown: true, highlight: true },
    workerRestart: {
      markdown: true,
      highlight: true,
      fullMarkdownRevision: true,
    },
    cancellation: { beforeQueue: true, whileQueued: true },
    formattedOutput: { markdown: true, highlight: true },
  })
}

run().catch((error: unknown) =>
  postJSON({
    pass: false,
    fixture: "worker-lifecycle",
    constructed,
    active,
    terminated,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
)
