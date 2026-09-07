export const external: string[] = []
export const fetched: string[] = []
const attempts = new Map<string, number>()
export async function openExternal(url: string) { external.push(url) }
export async function fetchThreadImage(_thread: string, path: string, signal: AbortSignal) {
  fetched.push(path)
  attempts.set(path, (attempts.get(path) ?? 0) + 1)
  if (path.endsWith("retry.png") && attempts.get(path) === 1) throw new Error("Connection interrupted")
  if (path.startsWith("/tmp/")) throw new Error("image must be inside the thread folder")
  signal.throwIfAborted()
  if (path.includes("sized-")) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    signal.throwIfAborted()
    const portrait = path.includes("portrait")
    const canvas = document.createElement("canvas")
    canvas.width = portrait ? 600 : 1600
    canvas.height = portrait ? 1800 : 900
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = path.includes("light") ? "#f4f4f4" : "#181818"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#888"
    ctx.font = "32px sans-serif"
    ctx.fillText("Question form preview", 30, 65)
    ctx.strokeStyle = "#888"
    ctx.strokeRect(30, 100, canvas.width - 60, 120)
    return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
  }
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: "image/png" })
}
