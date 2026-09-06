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
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: "image/png" })
}
