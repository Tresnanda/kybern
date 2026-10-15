// `components/kybern/ResponseImage.tsx`: a 280px-wide image (rounded 12, 8 when
// compact) or a 64px thumbnail, with a hairline outline. GPUIX's <img> needs a
// box, so the size comes from the image header (PNG, JPEG, GIF, WebP) read once
// per source.
import { closeSync, openSync, readSync } from 'node:fs'
import { useMemo } from 'react'
import { imageSource } from '../../../desktop/src/lib/responseImages.ts'
import { useTheme } from '../ui.tsx'
import { alpha, muted, Para } from './kit.tsx'

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
  sizes.set(source, size && size.width > 0 && size.height > 0 ? size : null)
  return sizes.get(source)!
}

function srcFor(source: string): string | null {
  const target = imageSource(source)
  if (!target) return null
  return target.kind === 'local' ? target.value : target.value
}

export function ResponseImage({ source, label = 'Agent image', compact = false, thumbnail = false }: { source: string; label?: string; compact?: boolean; thumbnail?: boolean }) {
  const t = useTheme()
  const size = useMemo(() => imageSize(source), [source])
  const src = srcFor(source)
  const outline = alpha(t.variant === 'dark' ? '#ffffff' : '#000000', 0.1)
  if (!src)
    return (
      <div style={{ padding: 16, borderRadius: 8, backgroundColor: t.buttonSecondary, marginTop: compact ? 0 : 12, marginBottom: compact ? 0 : 12 }}>
        <Para color={muted(t)} size={14}>Preview unavailable</Para>
      </div>
    )
  if (thumbnail)
    return <img src={src} alt={label} objectFit="cover" style={{ width: 64, height: 64, borderRadius: 12, borderWidth: 1, borderColor: outline, flexShrink: 0 }} />
  const width = Math.min(280, size?.width ?? 280)
  const height = size ? Math.round((width * size.height) / size.width) : 210
  return (
    <img
      src={src}
      alt={label}
      objectFit="contain"
      style={{ width, height, borderRadius: compact ? 8 : 12, borderWidth: 1, borderColor: outline, marginTop: compact ? 0 : 12, marginBottom: compact ? 0 : 12, flexShrink: 0 }}
    />
  )
}
