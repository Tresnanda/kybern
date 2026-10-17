/** Native clipboard payloads stay in memory until uploaded to the current environment. */
export interface ClipboardImage { data: Uint8Array; mediaType: string; name?: string }
interface ClipboardRenderer {
  readClipboardImage?: () => ClipboardImage | null
  readClipboardPaths?: () => string[]
}
export function clipboardAttachments(renderer: object): { paths: string[]; image: ClipboardImage | null } {
  const clipboard = renderer as ClipboardRenderer
  const paths = clipboard.readClipboardPaths?.() ?? []
  return { paths, image: paths.length ? null : clipboard.readClipboardImage?.() ?? null }
}
