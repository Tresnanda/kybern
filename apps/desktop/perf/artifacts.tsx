import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ResponseImage } from "../src/components/kybern/ResponseImage"
import { Markdown } from "../src/components/kybern/Markdown"
import { ImageThreadContext } from "../src/lib/imageThread"
import { external, fetched, requests } from "./artifacts-transport"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const view = createRoot(document.getElementById("root")!)
function render(text: string) { flushSync(() => view.render(<ImageThreadContext value="thread-1"><Markdown text={text} /></ImageThreadContext>)) }
function check(condition: unknown, message: string) { if (!condition) throw new Error(message) }
async function waitFor(condition: () => unknown, message: string) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    check(performance.now() < deadline, message)
    await sleep(20)
  }
}
async function waitForImage() {
  await waitFor(() => document.querySelector('[role="dialog"] img'), `Image preview did not load: ${document.body.innerText}`)
}
async function run() {
  render("[Dark preview](/workspace/artifacts/question.png)")
  await sleep(100)
  check(fetched.length === 0, "Image links eagerly load before opening")
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await waitForImage()
  check(external.length === 0, `Local preview went to openUrl: ${external[0]}`)
  check(!!document.querySelector('[role="dialog"] img'), `Local image link did not open a preview: ${document.body.innerText}; fetched=${fetched.join(",")}; images=${document.querySelectorAll("img").length}`)
  check(fetched.includes("/workspace/artifacts/question.png"), "Preview bypassed the thread image endpoint")
  const image = document.querySelector<HTMLImageElement>('[role="dialog"] img')!
  await Promise.race([image.decode(), sleep(3000).then(() => { throw new Error("Preview image decoding timed out") })])
  check(image.complete && image.naturalWidth > 0, "Preview image did not decode")
  for (const source of ["file:///workspace/artifacts/first%20pass.png", "artifacts/next.png"]) {
    render(`[Preview](${source})`)
    await sleep(60)
    document.querySelector<HTMLAnchorElement>("a")!.click()
    await waitForImage()
    check(!!document.querySelector('[role="dialog"] img'), `No preview for ${source}`)
  }
  check(fetched.includes("/workspace/artifacts/first pass.png"), "File URL was not decoded")
  render("[Preview](/tmp/outside.png)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await waitFor(() => document.body.innerText.includes("copy it into that folder"), "Blocked image guidance did not load")
  check(document.body.innerText.includes("copy it into that folder"), "Blocked image has no recovery guidance")
  check(!Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"), "Blocked path offers a useless retry")
  render("[Preview](artifacts/retry.png)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  await waitFor(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"), "Transient error did not appear")
  const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry")
  check(retry, "Transient error cannot be retried")
  retry!.click()
  await waitForImage()
  check(!!document.querySelector('[role="dialog"] img'), "Retry closed the preview or failed to reload")
  render("![Agent image](/tmp/inline.png)")
  await waitFor(() => document.body.innerText.includes("copy it into that folder"), "Blocked image guidance did not load")
  check(document.body.innerText.includes("copy it into that folder"), "Inline image has no recovery guidance")
  check(!Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Retry"), "Blocked inline image offers a useless retry")
  const root = document.getElementById("root")!
  root.style.width = "320px"
  render("![Dark question](artifacts/sized-dark-portrait.png)\n\n![Light question](artifacts/sized-light-landscape.png)")
  await waitFor(() => root.querySelectorAll(".response-image-preview").length === 2, "Inline preview placeholders did not mount")
  const before = root.getBoundingClientRect().height
  await waitFor(() => root.querySelectorAll(".response-image-preview img").length === 2, "Missing inline previews")
  const previews = Array.from(root.querySelectorAll<HTMLImageElement>(".response-image-preview img"))
  check(previews.length === 2, "Missing inline previews")
  await Promise.all(previews.map((image) => image.decode()))
  check(Math.abs(root.getBoundingClientRect().height - before) < 1, "Image loading moved surrounding text")
  for (const image of previews) {
    const rect = image.getBoundingClientRect()
    check(rect.width <= 280 && rect.height <= 176, "Image preview exceeds compact bounds")
    check(getComputedStyle(image).objectFit === "scale-down", "Preview crops or stretches images")
  }
  check(requests.filter((request) => request.path.includes("sized-")).every((request) => request.preview), "Inline images fetch full originals")
  check(previews.every((image) => image.naturalWidth <= 560 && image.naturalHeight <= 352), "Preview decode exceeds pixel budget")
  previews[0]!.closest("button")!.click()
  await waitForImage()
  const original = document.querySelector<HTMLImageElement>('[role="dialog"] img')!
  await original.decode()
  check(original.naturalHeight === 1800 && original.src !== previews[0]!.src, "Viewer does not fetch the full image")
  render("![Offscreen](artifacts/sized-offscreen.png)")
  root.style.marginTop = "3000px"
  await sleep(100)
  check(!fetched.includes("artifacts/sized-offscreen.png"), "Offscreen image fetched eagerly")
  root.style.marginTop = "0"
  await waitFor(() => fetched.includes("artifacts/sized-offscreen.png"), "Image did not load on approach")
  check(fetched.includes("artifacts/sized-offscreen.png"), "Image did not load on approach")
  flushSync(() => view.render(<ImageThreadContext value="thread-1"><div className="flex flex-wrap gap-2">{["portrait", "landscape"].map((shape) => <ResponseImage key={shape} compact source={`artifacts/sized-gallery-${shape}.png`} />)}</div></ImageThreadContext>))
  await waitFor(() => root.querySelectorAll(".response-image-preview").length === 2, "Gallery placeholders did not mount")
  const galleryHeight = root.getBoundingClientRect().height
  await waitFor(() => root.querySelectorAll(".response-image-preview img").length === 2, "Gallery previews did not load")
  await Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>("img"), (image) => image.decode()))
  check(Math.abs(root.getBoundingClientRect().height - galleryHeight) < 1, "Compact gallery shifts on image load")
  check(root.scrollWidth <= 321, "Compact gallery overflows narrow layout")
  root.style.height = "500px"
  root.style.overflowY = "auto"
  render(Array.from({ length: 40 }, (_, index) => `![Image ${index}](artifacts/sized-many-${index}.png)`).join("\n\n"))
  await waitFor(() => fetched.some((path) => path.includes("sized-many-")), "Long response did not load its visible previews")
  const many = fetched.filter((path) => path.includes("sized-many-"))
  check(many.length > 0 && many.length <= 8, `Long image response fetched ${many.length} previews immediately`)
  root.scrollTop = root.scrollHeight
  await waitFor(() => fetched.includes("artifacts/sized-many-39.png"), "Last image in a long response is unreachable")
  check(fetched.includes("artifacts/sized-many-39.png"), "Last image in a long response is unreachable")
  root.scrollTop = 0
  root.style.height = ""
  root.style.overflowY = ""
  render("| Agent | Where Kybern gets skills |\n| --- | --- |\n| Codex | Asks Codex for its effective catalog, preserving precedence and plugin namespaces. |\n| Claude | Scans project and home directories. |")
  await sleep(100)
  const cell = root.querySelector("td")!
  const range = document.createRange()
  range.selectNodeContents(cell)
  check(range.getClientRects().length === 1, "Table splits a short agent name across lines")
  render("| Path | Description |\n| --- | --- |\n| `" + "verylongpath".repeat(30) + "` | A long path |")
  await sleep(100)
  const table = root.querySelector<HTMLElement>(".chat-markdown-table")!
  check(table.scrollWidth > table.clientWidth, "Wide table has no local scrolling")
  check(root.scrollWidth <= 321, "Table overflows the conversation")
  root.style.width = ""
  render("[Docs](https://example.com/docs)")
  await sleep(60)
  document.querySelector<HTMLAnchorElement>("a")!.click()
  check(external.length === 1 && external[0] === "https://example.com/docs", "External link routing changed")
  root.style.cssText = "width:640px;max-width:100%;padding:24px"
  render("| Agent | Where Kybern gets skills |\n| --- | --- |\n| Codex | Asks Codex for its effective catalog, preserving precedence and plugin namespaces. |\n| Claude | Scans project and home directories. |\n\n![Dark question](artifacts/sized-dark-portrait.png)\n\n![Light question](artifacts/sized-light-landscape.png)")
  await waitFor(() => root.querySelectorAll("img").length === 2, "Final previews did not mount")
  await Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>("img"), (image) => image.decode()))
  check(Array.from(root.querySelectorAll<HTMLImageElement>("img")).every((image) => image.complete && image.naturalWidth > 0), "Final preview did not load")
}
const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
run().then(() => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true }))).catch((error) => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
