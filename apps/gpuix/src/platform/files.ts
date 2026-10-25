// Native save panel and image copy, the desktop's `save_text_file`,
// `save_html_file`, `save_image_file` and `write_image_clipboard`
// (src-tauri/src/text_export.rs, lib.rs). The destination is chosen in the
// native save panel (`promptForNewPath`, native/upstream/packages/native/src/window_platform.rs);
// callers never pass a path. Each resolves to false when the panel is dismissed.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { downloadsDir, savePanelDialog } from './os.ts'
import { readPref, writePref } from './prefs.ts'

interface FileHost {
  writeClipboardImage?: (data: Buffer, mediaType: string) => void
}
const LAST_DIR = 'kybern.save.directory'

/** Desktop `markdown_file_name`: no separators or control characters, never empty, always `.md`. */
export function markdownFileName(requested: string): string {
  const cleaned = [...requested.replace(/[/\\:]/g, '-')].filter(c => !/[\u0000-\u001f\u007f-\u009f]/.test(c)).join('').trim().replace(/^\.+/, '').trim()
  const stem = [...(cleaned.endsWith('.md') ? cleaned.slice(0, -3) : cleaned).trim()].slice(0, 120).join('')
  return stem ? `${stem}.md` : 'Untitled.md'
}
/** Desktop `html_file_name`. */
export function htmlFileName(requested: string): string {
  const cleaned = [...requested.replace(/[/\\:*?"<>|]/g, ' ')].filter(c => !/[\u0000-\u001f\u007f-\u009f]/.test(c)).join('').trim().replace(/^\.+/, '').trim()
  const stem = [...(cleaned.endsWith('.html') ? cleaned.slice(0, -5) : cleaned).trim()].slice(0, 120).join('')
  return stem ? `${stem}.html` : 'Visual.html'
}
/** Desktop `image_file_name`. */
export function imageFileName(requested: string | undefined): string {
  const safe = [...(requested ?? 'image.png').replace(/[/\\]/g, '-')].filter(c => !/[\u0000-\u001f\u007f-\u009f]/.test(c)).join('')
  return safe || 'image.png'
}

/** Ask where to save, starting in the last folder used (Downloads at first). Null when dismissed. */
async function choose(host: object | null | undefined, suggested: string, extensions: string[]): Promise<string | null> {
  // The patched addon's panel on every platform; without it Windows and Linux fall back to a PowerShell or zenity/kdialog panel.
  const directory = readPref<string | null>(LAST_DIR, null) ?? downloadsDir()
  const chosen = await savePanelDialog(host, directory, suggested)
  if (!chosen) return null
  if (!path.basename(chosen)) throw Error('Choose a file name first.')
  writePref(LAST_DIR, path.dirname(chosen))
  // The panel has no type filter: keep the expected extension, as the desktop's filter does.
  return extensions.some(ext => chosen.toLowerCase().endsWith(`.${ext}`)) ? chosen : `${chosen}.${extensions[0]}`
}

/** A note exported as Markdown (desktop: limit 2 MiB, title "Export note"). */
export async function saveTextFile(host: object | null | undefined, fileName: string, contents: string): Promise<boolean> {
  if (Buffer.byteLength(contents) > 2 * 1024 * 1024) throw Error('This note is too large to export. Copy it as Markdown instead.')
  const target = await choose(host, markdownFileName(fileName), ['md', 'markdown'])
  if (!target) return false
  await writeFile(target, contents).catch((error) => { throw Error(`write file: ${error.message}`) })
  return true
}

/** A durable HTML visual (desktop: 25 MiB + 64 KiB, title "Save visual"). */
export async function saveHtmlFile(host: object | null | undefined, fileName: string, contents: string): Promise<boolean> {
  if (Buffer.byteLength(contents) > 25 * 1024 * 1024 + 64 * 1024) throw Error('This visual is too large to save. Ask the agent to use smaller images.')
  const target = await choose(host, htmlFileName(fileName), ['html', 'htm'])
  if (!target) return false
  await writeFile(target, contents).catch((error) => { throw Error(`Unable to save the visual: ${error.message}. Choose another location and retry.`) })
  return true
}

/** Image bytes from a reply (desktop "Download image"). */
export async function saveImageFile(host: object | null | undefined, data: Uint8Array, fileName?: string): Promise<boolean> {
  const name = imageFileName(fileName)
  const ext = path.extname(name).slice(1).toLowerCase()
  const target = await choose(host, name, [...new Set([ext || 'png', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])])
  if (!target) return false
  await writeFile(target, data).catch((error) => { throw Error(`write image file: ${error.message}`) })
  return true
}

/** The image's media type from its leading bytes; null when it is not one the pasteboard takes. */
export function sniffImage(data: Uint8Array): string | null {
  const b = Buffer.from(data.subarray(0, 16))
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif'
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('latin1', 0, 2) === 'BM') return 'image/bmp'
  if (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*') return 'image/tiff'
  return null
}

/** Put an image on the system pasteboard (desktop "Copy image"). */
export function copyImage(host: object | null | undefined, data: Uint8Array) {
  const write = (host as FileHost | null | undefined)?.writeClipboardImage
  if (!write) throw Error('Image copying needs the patched native module. Rebuild it with native/update.sh.')
  const type = sniffImage(data)
  if (!type) throw Error('Image copying is not available for this image type.')
  write.call(host, Buffer.from(data), type)
}
