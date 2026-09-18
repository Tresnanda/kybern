export const assets = { reads: 0, aborted: 0, delay: 0, fail: false }
export async function fetchAssetImage(id: string, signal: AbortSignal) {
  if (id !== "upload") throw new Error("Unexpected asset")
  assets.reads++
  await new Promise(resolve => setTimeout(resolve, assets.delay))
  if (signal.aborted) { assets.aborted++; signal.throwIfAborted() }
  if (assets.fail) throw new Error("Try again")
  return new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="), char => char.charCodeAt(0))], { type: "image/png" })
}
