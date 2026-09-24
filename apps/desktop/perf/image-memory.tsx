import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThemeProviderContext } from "../src/components/theme-context"
import { ResponseImage } from "../src/components/kybern/ResponseImage"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const native = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function mark(stage: string) {
  await new Promise<void>((resolve) => {
    native.__memoryContinue = resolve
    native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true }))
  })
}
function render(sources: string[]) {
  flushSync(() => root.render(<ThemeProviderContext value={{ theme: "light", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 64px)", gap: 16, padding: 24 }}>
      {sources.map((source) => <ResponseImage key={source} source={source} thumbnail />)}
    </div>
  </ThemeProviderContext>))
}
async function makeSource(index: number) {
  const canvas = document.createElement("canvas")
  canvas.width = 2048
  canvas.height = 2048
  const context = canvas.getContext("2d")!
  context.fillStyle = `hsl(${index * 29} 55% 50%)`
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "white"
  context.fillRect(index * 13, 20, 100, 100)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG creation failed")), "image/png"))
  canvas.width = 0
  canvas.height = 0
  return URL.createObjectURL(blob)
}
async function run() {
  const sources: string[] = []
  try {
    for (let index = 0; index < 12; index++) sources.push(await makeSource(index))
    await mark("image-sources-ready")
    render(sources)
    const deadline = performance.now() + 20000
    let images: HTMLImageElement[] = []
    while (performance.now() < deadline) {
      images = [...document.querySelectorAll<HTMLImageElement>(".response-image-preview img")]
      if (images.length === sources.length) break
      await sleep(25)
    }
    check(images.length === sources.length, `Only ${images.length} thumbnails loaded`)
    await Promise.all(images.map((image) => image.decode()))
    await sleep(2000)
    await mark("image-chips-settled")
    const widths = images.map((image) => image.naturalWidth)
    document.querySelector<HTMLButtonElement>(".response-image-preview")!.click()
    let original: HTMLImageElement | null = null
    const originalDeadline = performance.now() + 5000
    while (performance.now() < originalDeadline) {
      original = document.querySelector<HTMLImageElement>('[role="dialog"] img')
      if (original) break
      await sleep(25)
    }
    check(original, "Original image dialog did not open")
    await original.decode()
    check(original.naturalWidth === 2048 && original.src === sources[0], "Original image was replaced by the thumbnail")
    flushSync(() => root.render(null))
    await sleep(2000)
    await mark("image-chips-unmounted")
    native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, images: images.length, widths, createImageBitmap: typeof createImageBitmap }))
  } finally {
    flushSync(() => root.unmount())
    sources.forEach((source) => URL.revokeObjectURL(source))
  }
}
run().catch((error) => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
