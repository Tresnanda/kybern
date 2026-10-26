// The Linux half of an embedded document's placeholder (WP10): GPUIX's `<websurface>` paints the page that
// `webview-linux.c` renders offscreen, in the element tree, so popups, clips and fades apply to it like any element.
// Placeholders render it as their last child; on macOS (native web views float over the window) it renders nothing.
import type { Props } from '@gpuix/react'
import { webHost } from './webview.ts'

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      /** `doc`: the `webHost` document id; `lib`: the companion (`webHost.surfaceLibrary`); `slot`: which placeholder (`place`'s `slot`). */
      websurface: Props & { doc: string; lib: string; slot?: string }
    }
  }
}

const FILL = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } as const
/** Style for a placeholder that hosts a `WebSurface`: positioned on Linux so the surface can fill it; nothing on macOS. */
export const WEB_SURFACE_HOST = webHost.surfaceLibrary ? { position: 'relative' } as const : {}

/** Fills its (positioned) parent; the page sits where `webHost.place` put it relative to that parent. */
export function WebSurface({ id, slot = '', testId }: { id: string; slot?: string; testId?: string }) {
  const lib = webHost.surfaceLibrary
  if (!lib) return null
  return <websurface doc={id} lib={lib} slot={slot} testId={testId ?? 'web-surface'} style={FILL} />
}
