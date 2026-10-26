// A visual where no page can run in Kybern (no embedded web view): the daemon's picture at the box's size, scrollable when
// the page is taller, and the one way to use the page, Open in browser. The full-screen viewer and the visual tab show it
// in place of the live document (`webHost.available` false, `visualFallback.ts`).
import { useEffect, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { JsonValue } from '../../../../packages/kybern-client/src/types.ts'
import type { VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
import { observeElementBounds } from '../native/layout.ts'
import { visualTheme } from '../preview/theme.ts'
import { Button } from '../kit/Button.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { Label, useTheme } from '../ui.tsx'
import { toast } from '../shell/toasts.tsx'
import { openVisualInBrowser } from './visualDocs.ts'
import { STATIC_VISUAL } from './visualFallback.ts'
import { usePicture } from './visualPicture.ts'

/** Open the visual in the browser; `busy` while the ticket is minted, a toast says what to do when it fails. */
export function useOpenVisualInBrowser(threadId: string, visualId: string) {
  const t = useTheme(), [busy, setBusy] = useState(false)
  const open = () => {
    if (busy) return
    setBusy(true)
    openVisualInBrowser(threadId, visualId, visualTheme(t)).catch(error => toast.error(STATIC_VISUAL.openFailed, { description: String(error?.message ?? error) || STATIC_VISUAL.openFailedHint })).finally(() => setBusy(false))
  }
  return { open, busy }
}

export function OpenInBrowserButton({ threadId, visualId, variant = 'secondary', testId = 'visual-open-browser' }: { threadId: string; visualId: string; variant?: 'secondary' | 'ghost' | 'primary'; testId?: string }) {
  const { open, busy } = useOpenVisualInBrowser(threadId, visualId)
  return <Button size="sm" variant={variant} testId={testId} busy={busy} onClick={open}>{busy ? STATIC_VISUAL.opening : STATIC_VISUAL.openBrowser}</Button>
}

export function VisualStill({ threadId, visualId, theme, lock = null, testId = 'visual-still' }: { threadId: string; visualId: string; theme: VisualTheme; lock?: JsonValue | null; testId?: string }) {
  const t = useTheme(), renderer = useGpuixRequired()
  const [host, setHost] = useState<PublicInstance | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => host ? observeElementBounds(renderer, host.id, e => { if (e.rect) setBox(b => b && Math.abs(b.width - e.rect!.width) < 1 && Math.abs(b.height - e.rect!.height) < 1 ? b : { width: e.rect!.width, height: e.rect!.height }) }) : undefined, [renderer, host])
  const width = box ? Math.max(120, Math.round(box.width)) : null
  const { picture, error, retry } = usePicture(threadId, visualId, width, theme, lock)
  const height = picture && width ? Math.round(picture.height * width / picture.width) : 0
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, gap: 12 }}>
    <div ref={setHost} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
      {picture && width ? <div testId="visual-still-scroll" style={{ height: box?.height ?? height, overflow: 'scroll' }}>
        <img testId="visual-still-picture" src={picture.path} alt="" objectFit="fill" style={{ width, height, pointerEvents: 'none' }} />
      </div>
        : error ? <div testId="visual-error" style={{ display: 'flex', flexGrow: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
          <Label color={t.text} weight={500} style={{ textAlign: 'center' }}>Couldn’t show this visual</Label>
          <Label color={t.textSecondary} size={13} style={{ textAlign: 'center', lineClamp: 2 }}>{error}</Label>
          <Button testId="visual-retry" onClick={retry}>Reload</Button>
        </div>
          : <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 6 }}><Spinner size={12} color={t.textTertiary} /><Label color={t.textTertiary} size={12}>Rendering…</Label></div>}
    </div>
    <div testId="visual-still-footer" style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
      <Label color={t.textSecondary} size={12} lineHeight={17} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, whiteSpace: 'normal' }}>{STATIC_VISUAL.hint}</Label>
      <OpenInBrowserButton threadId={threadId} visualId={visualId} variant="primary" testId="visual-still-open-browser" />
    </div>
  </div>
}
