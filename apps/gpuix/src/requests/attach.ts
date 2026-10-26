// What "Point for me" and a question's Attach share: the image types Kybern uploads, the system window capture, and the
// upload of a chosen image. The Pick card (`Pick.tsx`) and the question card (`Question.tsx`) both build on these.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { uploadBytes } from '../composer/store.ts'

export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', avif: 'image/avif', pdf: 'application/pdf' }

export const imageType = (path: string): string | undefined => IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']

/** An uploaded image, with a data URL to show when the type has one (PDFs and HEIC show their name only). */
export interface UploadedImage { assetId: string; name: string; size: number; preview: string | null }

export async function uploadImage(name: string, mediaType: string, bytes: Uint8Array): Promise<UploadedImage> {
  const asset = await uploadBytes(name, mediaType, bytes)
  return { assetId: asset.id, name, size: bytes.byteLength, preview: /^image\/(png|jpeg|gif|webp)$/.test(mediaType) ? `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` : null }
}

/** Upload an image file the user chose. Throws with a sentence that says what to choose instead. */
export async function uploadImageFile(path: string): Promise<UploadedImage> {
  const mediaType = imageType(path)
  if (!mediaType) throw new Error('Choose a PNG, JPEG, GIF, WebP, HEIC or PDF file.')
  return uploadImage(basename(path), mediaType, readFileSync(path))
}

/**
 * The system's own capture (`screencapture -i -W`): click a window (space switches between window and area), or drag an area;
 * Esc cancels. Resolves with the PNG bytes, or null when the user cancelled. `onChild` gets the process so a closing card can stop it.
 */
export function captureWindow(onChild?: (child: ChildProcess | null) => void): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Window capture is available on macOS only. Attach an image instead.'))
  const path = join(tmpdir(), `kybern-window-${crypto.randomUUID()}.png`)
  return new Promise((resolve, reject) => {
    const proc = spawn('screencapture', ['-i', '-W', '-o', '-x', path], { stdio: 'ignore' })
    onChild?.(proc)
    proc.on('error', () => { onChild?.(null); reject(new Error('Unable to start the capture. Try again.')) })
    proc.on('close', () => {
      onChild?.(null)
      try {
        resolve(statSync(path, { throwIfNoEntry: false })?.size ? readFileSync(path) : null)
      } catch (e) {
        reject(e)
      } finally {
        try { rmSync(path, { force: true }) } catch { /* gone */ }
      }
    })
  })
}
