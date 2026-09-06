import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Markdown } from "../src/components/kybern/Markdown"
import { ImageThreadContext } from "../src/lib/imageThread"
import { external, fetched } from "./artifacts-transport"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const view = createRoot(document.getElementById("root")!)
function render(text: string) { flushSync(() => view.render(<ImageThreadContext value="thread-1"><Markdown text={text} /></ImageThreadContext>)) }
function check(condition: unknown, message: string) { if (!condition) throw new Error(message) }
async function run() {
  render("[Dark preview](/workspace/artifacts/question.png)")
  await sleep(100)
  check(fetched.length === 0, "Image links eagerly load before opening")
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await sleep(100)
  check(external.length === 0, `Local preview went to openUrl: ${external[0]}`)
  check(!!document.querySelector('[role="dialog"] img'), `Local image link did not open a preview: ${document.body.innerText}; fetched=${fetched.join(",")}; images=${document.querySelectorAll("img").length}`)
  check(fetched.includes("/workspace/artifacts/question.png"), "Preview bypassed the thread image endpoint")
  const image = document.querySelector<HTMLImageElement>('[role="dialog"] img')!
  check(image.complete && image.naturalWidth > 0, "Preview image did not decode")
  for (const source of ["file:///workspace/artifacts/first%20pass.png", "artifacts/next.png"]) {
    render(`[Preview](${source})`)
    await sleep(60)
    document.querySelector<HTMLAnchorElement>("a")!.click()
    await sleep(100)
    check(!!document.querySelector('[role="dialog"] img'), `No preview for ${source}`)
  }
  check(fetched.includes("/workspace/artifacts/first pass.png"), "File URL was not decoded")
  render("[Preview](/tmp/outside.png)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await sleep(100)
  check(document.body.innerText.includes("copy it into that folder"), "Blocked image has no recovery guidance")
  check(!Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"), "Blocked path offers a useless retry")
  render("[Preview](artifacts/retry.png)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await sleep(100)
  const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry")
  check(retry, "Transient error cannot be retried")
  retry!.click()
  await sleep(100)
  check(!!document.querySelector('[role="dialog"] img'), "Retry closed the preview or failed to reload")
  render("![Agent image](/tmp/inline.png)")
  await sleep(100)
  check(document.body.innerText.includes("copy it into that folder"), "Inline image has no recovery guidance")
  check(!Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"), "Blocked inline image offers a useless retry")
  render("[Docs](https://example.com/docs)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  check(external.length === 1 && external[0] === "https://example.com/docs", "External link routing changed")
}
const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
run().then(() => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true }))).catch((error) => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
