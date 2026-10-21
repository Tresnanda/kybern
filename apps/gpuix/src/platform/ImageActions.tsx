// The image preview's "Copy image" and "Download image" buttons (desktop
// `ResponseImage.tsx`): copy swaps to a green check for 1.4 s; download opens
// the native save panel. Both use `platform/files.ts`. Failures toast with the
// desktop's copy.
import { readFile } from 'node:fs/promises'
import { useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { Download04Icon } from '@hugeicons/core-free-icons'
import { imageSource } from '../../../desktop/src/lib/responseImages.ts'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Tip, muted } from '../nav/overlay.tsx'
import { toast } from '../shell/toasts.tsx'
import { SwapOnChange } from '../transcript/motion.tsx'
import { useTheme } from '../ui.tsx'
import { copyImage, saveImageFile, sniffImage } from './files.ts'

const DOWNLOAD = glyph(Download04Icon)

/** The image's bytes, from a data URL, a local path or the network. */
export async function imageBytes(source: string): Promise<Uint8Array> {
  const target = imageSource(source)
  if (!target) throw Error('Unsupported image source')
  if (target.kind === 'inline') return Buffer.from(target.value.slice(target.value.indexOf(',') + 1), 'base64')
  if (target.kind === 'local') return readFile(target.value)
  const response = await fetch(target.value, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw Error(`Image request failed with ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Desktop `imageDownloadName`. */
export function imageDownloadName(label: string, data: Uint8Array): string {
  const safe = label.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'image'
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(safe)) return safe
  const type = sniffImage(data)?.split('/')[1]
  return `${safe}.${type === 'jpeg' ? 'jpg' : type || 'png'}`
}

function ActionButton({ label, testId, disabled, onClick, children }: { label: string; testId: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  const t = useTheme()
  return <Tip label={label} side="bottom" size={28}>
    <div testId={testId} role="button" aria-label={label} onClick={() => { if (!disabled) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, hover: { backgroundColor: t.buttonTertiaryHover } }}>{children}</div>
  </Tip>
}

/** Placed in the preview header, left of its close button. */
export function ImageActions({ source, label }: { source: string; label: string }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null)
  const [copied, setCopied] = useState(false)
  const run = async (kind: 'copy' | 'download') => {
    if (busy) return
    setBusy(kind)
    try {
      const data = await imageBytes(source)
      if (kind === 'copy') {
        copyImage(renderer, data)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      } else await saveImageFile(renderer, data, imageDownloadName(label, data))
    } catch {
      toast.error(kind === 'copy' ? 'Unable to copy image' : 'Unable to download image', { description: kind === 'copy' ? 'Use Download image instead, or check clipboard permissions.' : 'Check that the image is still available, then retry.' })
    } finally { setBusy(null) }
  }
  return <div style={{ position: 'absolute', top: 10, right: 44, display: 'flex', gap: 4 }}>
    <ActionButton label={copied ? 'Image copied' : 'Copy image'} testId="image-copy" disabled={busy !== null} onClick={() => void run('copy')}>
      <SwapOnChange kind="icon" active={copied ? 'check' : 'copy'}><Icon source={copied ? N.check : ICONS.copy} size={14} color={copied ? t.green : muted(t, 1)} /></SwapOnChange>
    </ActionButton>
    <ActionButton label="Download image" testId="image-download" disabled={busy !== null} onClick={() => void run('download')}>
      <Icon source={DOWNLOAD} size={14} color={muted(t, 1)} />
    </ActionButton>
  </div>
}
