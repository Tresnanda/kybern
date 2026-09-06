import { createMarkdownParser, type ParsedMarkdown } from "./markdownParser"
import type { MarkdownJob, MarkdownReply } from "./markdownQueue"
const sessions = new Map<number, { parser: ReturnType<typeof createMarkdownParser>; parsed?: ParsedMarkdown; revision: number; bytes: number }>()
let revision = 0
self.onmessage = (event: MessageEvent<MarkdownJob | { release: number }>) => {
  const job = event.data
  if ("release" in job) { sessions.delete(job.release); return }
  const session = sessions.get(job.consumer) ?? { parser: createMarkdownParser(), revision: 0, bytes: 0 }
  sessions.delete(job.consumer)
  let prefix = 0
  const parsed = session.parser.parse(job.source)
  if (session.revision === job.baseRevision && session.parsed) {
    while (prefix < parsed.blocks.length && parsed.blocks[prefix] === session.parsed.blocks[prefix]) prefix++
  }
  session.parsed = parsed
  session.revision = ++revision
  session.bytes = job.source.length * 2 + parsed.blocks.reduce((sum, block) => sum + block.signature.length * 2, 0)
  sessions.set(job.consumer, session)
  let bytes = [...sessions.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  for (const [id, entry] of sessions) {
    if (sessions.size <= 16 && bytes <= 8 * 1024 * 1024) break
    sessions.delete(id)
    bytes -= entry.bytes
  }
  self.postMessage({ id: job.id, revision: session.revision, prefix, blocks: parsed.blocks.slice(prefix) } satisfies MarkdownReply)
}
