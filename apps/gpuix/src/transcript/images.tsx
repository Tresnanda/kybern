import { ImageCard } from './ThreadImage.tsx'
import { useTranscriptRowLease, useTranscriptFocusRestoration } from './Window.tsx'
// `components/kybern/ResponseImage.tsx`: a 280px-wide image (rounded 12, 8 when
// compact) or a 64px thumbnail, with a hairline outline. GPUIX's <img> needs a
// box, so the size comes from the image header (PNG, JPEG, GIF, WebP) read once
// per source.
import { closeSync, openSync, readSync } from 'node:fs'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useGpuixRequired } from '@gpuix/react'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { ImageViewer, useImageViewer } from '../motion/ImageMorph.tsx'
import { imageSource } from '../../../../packages/kybern-client/src/responseImages.ts'
import { EASE_OUT, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { DURATION, Rise, ZOOM } from '../motion/kit.tsx'
import { alpha } from './kit.tsx'
import { useFresh } from './motion.tsx'
import { usePaneAccess } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { useImageFiles } from './imageFiles.ts'
import { useAssetSource } from './assetSource.ts'
import { Label } from '../ui.tsx'

const sizes = new Map<string, { width: number; height: number } | null>()

function headerBytes(source: string): Uint8Array | null {
  const target = imageSource(source)
  if (!target) return null
  if (target.kind === 'inline') {
    const comma = target.value.indexOf(',')
    // 64 KiB of base64 covers any JPEG SOF marker in practice.
    return Buffer.from(target.value.slice(comma + 1, comma + 1 + 87_384), 'base64')
  }
  if (target.kind === 'local') {
    try {
      const fd = openSync(target.value, 'r')
      const buffer = Buffer.alloc(65_536)
      const n = readSync(fd, buffer, 0, buffer.length, 0)
      closeSync(fd)
      return buffer.subarray(0, n)
    } catch {
      return null
    }
  }
  return null
}

function parseSize(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
  if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) }
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      const length = u16(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: u16(i + 7), height: u16(i + 5) }
      i += 2 + length
    }
    return null
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
    if (kind === 'VP8 ') return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff }
    if (kind === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

export function imageSize(source: string): { width: number; height: number } | null {
  if (sizes.has(source)) return sizes.get(source)!
  const bytes = headerBytes(source)
  const size = bytes ? parseSize(bytes) : null
  const valid = size && size.width > 0 && size.height > 0 ? size : null
  // Do not pin large data URLs in a module cache after their row unmounts.
  if (source.length <= 8192) {
    if (sizes.size >= 128) sizes.delete(sizes.keys().next().value!)
    sizes.set(source, valid)
  }
  return valid
}

function srcFor(source: string): string | null {
  const target = imageSource(source)
  if (!target) return null
  return target.kind === 'local' ? target.value : target.value
}

/**
 * `at` is when the image arrived: one that just did resolves from a blur (`t-img`, 400 ms); history and recycled rows paint plainly.
 * A click morphs the image into the shared preview (`motion/ImageMorph.tsx`); Enter or Space opens it at once.
 */
/** `tabSource`: what an image tab reloads from (a thread-relative path), when `source` is already the loaded data. */
/** `maxWidth` / `maxHeight`: the largest box the image is drawn in (280 wide by default; an issue's images are larger). */
type ResponseImageProps = { source: string; tabSource?: string; label?: string; compact?: boolean; thumbnail?: boolean; at?: string; maxWidth?: number; maxHeight?: number }

/** An image stored outside the event log (`kybern://asset/<id>`, #298) loads from the thread's machine first. */
export function ResponseImage(props: ResponseImageProps) {
  const target = imageSource(props.source)
  return target?.kind === 'asset' ? <AssetResponseImage {...props} path={target.value} /> : <LoadedResponseImage {...props} />
}

function AssetResponseImage({ path, ...props }: ResponseImageProps & { path: string }) {
  const t = useTheme()
  const image = useAssetSource(path)
  if (image.source) return <LoadedResponseImage {...props} source={image.source} />
  if (!props.thumbnail) return <ImageCard label={props.label ?? 'Agent image'} loading={!image.failed} reason={image.failed ? 'This image could not be loaded. Try again when its machine is reachable.' : undefined} />
  // A 64 px thumbnail keeps its slot while it loads, as an attachment does.
  return <div testId="response-image-loading" style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: alpha(t.variant === 'dark' ? '#ffffff' : '#000000', 0.04), alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    {image.failed && <Label color={t.textSecondary} size={12}>Unavailable</Label>}
  </div>
}

function LoadedResponseImage({ source, tabSource, label = 'Agent image', compact = false, thumbnail = false, at, maxWidth = 280, maxHeight }: ResponseImageProps) {
  const t = useTheme()
  const fresh = useFresh(at)
  // `t-img` starts when the bitmap has decoded (`<img onLoad>`), not on mount, so the blur resolves over the picture
  // itself; a decode that never reports does not hide it for long.
  const [decoded, setDecoded] = useState(!fresh)
  useEffect(() => { if (decoded) return; const id = setTimeout(() => setDecoded(true), 1500); return () => clearTimeout(id) }, [decoded])
  const renderer = useGpuixRequired()
  const pane = usePaneAccess()
  const restoreFocus = useTranscriptFocusRestoration()
  // The thumbnail paints the image cropped (`cover`); the reply image shows all of it.
  const viewer = useImageViewer({ radius: compact ? 8 : 12, fit: thumbnail ? 'cover' : 'contain' })
  const size = useMemo(() => imageSize(source), [source])
  const src = srcFor(source)
  const outline = alpha(t.variant === 'dark' ? '#ffffff' : '#000000', 0.1)
  if (!src) return <ImageCard label={label} reason="This image source cannot be shown. Open the file to view it." />
  const box = boxFor(size, maxWidth, maxHeight)
  const width = thumbnail ? 64 : box.width
  const height = thumbnail ? 64 : box.height
  // Painted from a file at most twice the slot wide; the viewer opens the original (`imageFiles.ts`).
  const files = useImageFiles(src, width * 2, size?.width ?? null)
  return (
    <>
    <Rise kind="image" play={fresh} hold={!decoded} style={{ flexShrink: 0 }}>
    <div
      ref={(node) => { viewer.node.current = node }}
      testId="response-image"
      tabIndex={0}
      role="button"
      aria-label={`Preview ${label}`}
      onClick={() => viewer.show(true)}
      onKeyDown={event => { if (event.key === 'enter' || event.key === 'space') viewer.show(false) }}
      style={{ display: 'flex', width, height, cursor: 'pointer', marginTop: compact || thumbnail ? 0 : 12, marginBottom: compact || thumbnail ? 0 : 12, flexShrink: 0, opacity: viewer.away ? 0 : 1 }}
    >
      {files && <img src={files.inline} alt={label} objectFit={thumbnail ? "cover" : "contain"} onLoad={decoded ? undefined : () => setDecoded(true)}
        style={{ width, height, borderRadius: compact ? 8 : 12, borderWidth: 1, borderColor: outline, pointerEvents: 'none' }} />}
    </div>
    </Rise>
    {viewer.open && <ImageViewer testId="image-lightbox" src={files?.full ?? src} label={label} from={viewer.open.from} source={viewer.source} finalFocus={() => {
      const trigger = viewer.node.current
      if (trigger) {
        if (restoreFocus) restoreFocus(trigger.id)
        else renderer.focusElement?.(trigger.id)
      }
    }} onClose={viewer.hide} onOpenInTab={() => openTabFromPane(pane.id, { kind: 'image', source: tabSource ?? source, label })} />}
    </>
  )
}

/** The box an image of `size` is drawn in: its own size, at most `maxWidth` wide and `maxHeight` high, keeping its shape.
 *  Unknown sizes take a 4:3 box `maxWidth` wide (at most 280). */
export function boxFor(size: { width: number; height: number } | null, maxWidth = 280, maxHeight?: number): { width: number; height: number } {
  if (!size) { const width = Math.min(280, maxWidth); return { width, height: Math.round(width * 0.75) } }
  let width = Math.min(maxWidth, size.width)
  let height = Math.round((width * size.height) / size.width)
  if (maxHeight && height > maxHeight) { height = maxHeight; width = Math.max(1, Math.round((maxHeight * size.width) / size.height)) }
  return { width, height }
}

/** An image that cannot be shown, in a dialog with its caption and what to do (a clicked image link that failed to load). The
 * fade and a 4px entrance offset; Reduce Motion is opacity only. */
export function ImageLightbox({ label, onClose, finalFocus, body }: { label: string; onClose: () => void; finalFocus: () => void; body: ReactNode }) {
  const renderer = useGpuixRequired()
  const window = renderer.getWindowSize?.() ?? { width: 900, height: 600 }
  useTranscriptRowLease(true)
  const [closing, setClosing] = useState(false)
  return <Dialog width={Math.min(1000, window.width - 80) + 32} onClose={() => setClosing(true)} finalFocus={finalFocus} testId="image-lightbox" instant>
    <motion.div
      initial={{ opacity: 0, top: REDUCED_MOTION ? 0 : 4 }}
      animate={{ opacity: closing ? 0 : 1, top: closing && !REDUCED_MOTION ? 4 : 0 }}
      transition={{ duration: REDUCED_MOTION ? DURATION.quick : closing ? ZOOM.close : ZOOM.open, ease: REDUCED_MOTION ? EASE_OUT : [...ZOOM.ease] as [number, number, number, number] }}
      onMotionComplete={() => { if (closing) onClose() }}
      style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}
    >
      <DialogHeader title={label} onClose={() => setClosing(true)} />
      {body}
    </motion.div>
  </Dialog>
}

