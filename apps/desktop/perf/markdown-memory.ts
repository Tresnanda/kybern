import { parseMarkdown } from "../src/lib/markdown"
import { retainedSize } from "../src/lib/retainedSize"
import type { MarkdownReply } from "../src/lib/markdownQueue"
const retained: MarkdownReply[] = []
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function mark(stage: string) {
  await sleep(300)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true, retainedBytes: retainedSize([...retained]) })) })
}
async function run() {
  await mark("markdown-startup")
  for (let i = 0; i < 8; i++) {
    const source = Array.from({ length: 350 }, (_, j) => `## Section ${i}-${j}\n\n**Formatted** paragraph with a [link](https://example.test/${i}/${j}) and \`inline code\`.\n\n| A | B |\n| --- | --- |\n| ${i} | ${j} |`).join("\n\n")
    const result = await parseMarkdown({ source, consumer: i + 1, baseRevision: 0 }, new AbortController().signal)
    if (!result || result.blocks.length < 1000) throw new Error("Formatted history lost its structure")
    retained.push(result)
  }
  await mark("markdown-retained")
  await sleep(32_000)
  await mark("markdown-workers-released")
  const retainedBytes = retainedSize([...retained])
  w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: retained.length === 8 && retainedBytes < 36 * 1024 * 1024, retainedBytes, budgetBytes: 36 * 1024 * 1024, fixtures: retained.length }))
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
