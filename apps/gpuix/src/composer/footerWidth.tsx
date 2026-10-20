// The composer footer is a CSS container on the desktop (`@container` on `data-chat-composer-footer`): its chips collapse by the
// footer's content width, not the window's. `@max-[N px]` means width < N. The breakpoints used by `views/Composer.tsx` and
// `ComposerModelTriggerLabel.tsx`:
//   < 620  effort and other traits ("High", "1M") leave the model chip
//   < 480  the permission label (icon stays), the account name and the model qualifier
//   < 360  the model name (mark and chevron stay); the Queue button becomes an icon (clock, or the spinner while sending)
// The width comes from the native layout observer (post-paint, changes only, no timer); only a breakpoint crossing re-renders.
import { createContext, memo, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { StyleDesc } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'

export interface FooterFit {
  /** `@max-[620px]:hidden`: effort and traits. */
  effort: boolean
  /** `@max-[480px]`: permission label, account name, qualifier. */
  labels: boolean
  /** `@max-[360px]`: model name; Queue collapses to an icon. */
  model: boolean
}

export const fitFor = (width: number | null): FooterFit => (width == null ? { effort: true, labels: true, model: true } : { effort: width >= 620, labels: width >= 480, model: width >= 360 })

const FooterFitContext = createContext<FooterFit>(fitFor(null))
export const useFooterFit = () => use(FooterFitContext)

/** The footer row: a flex row whose own content width feeds `FooterFit` to its chips. `children` keep their identity, so a breakpoint crossing re-renders only the chips that read the context. */
export const FooterRow = memo(function FooterRow({ children, style }: { children: ReactNode; style: StyleDesc }) {
  const renderer = useGpuixRequired()
  const ref = useRef<PublicInstance | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const id = ref.current?.id
    if (id == null) return
    return observeElementBounds(renderer, { id }, (event) => { if (event.rect) setWidth(event.rect.width) })
  }, [renderer])
  const fit = useMemo(() => fitFor(width), [width == null ? -1 : width >= 620 ? 3 : width >= 480 ? 2 : width >= 360 ? 1 : 0])
  return (
    <FooterFitContext value={fit}>
      <div ref={(el) => { ref.current = el }} testId="composer-footer" style={style}>{children}</div>
    </FooterFitContext>
  )
})
