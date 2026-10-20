// A settled ```mermaid fence (`components/kybern/MermaidBlock.tsx`): the code header carries a
// Preview/Source switch with a sliding pill and an expand button; the preview is the rendered
// diagram as an image (`mermaid.ts`), failures stay readable as source with a note.
import { useTranscriptRowLease } from './Window.tsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Pill, useSlidingPill } from '../composer/SlidingPill.tsx'
import { Icon } from '../icons.tsx'
import { Label, ink, useTheme } from '../ui.tsx'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { CopyAction } from './bubble.tsx'
import { CODE, muted } from './kit.tsx'
import { CodeChunk, lineChunks } from './markdown.tsx'
import { T } from './glyphs.ts'
import { renderMermaid, type DiagramImage } from './mermaid.ts'

/** `.chat-diagram-canvas`: padding .5rem 1rem 1rem; the image is at most 24rem tall. */
const CANVAS = { top: 8, side: 16, bottom: 16, maxHeight: 384 }
let lastWidth = 640

function useDiagram(code: string, dark: boolean) {
  const [result, setResult] = useState<{ code: string; dark: boolean; image: DiagramImage | null } | null>(null)
  useEffect(() => {
    const control = new AbortController()
    void renderMermaid(code, dark, control.signal).then(image => { if (!control.signal.aborted) setResult({ code, dark, image }) })
    return () => control.abort()
  }, [code, dark])
  const current = result?.code === code && result.dark === dark ? result : null
  return current ? (current.image ? ({ status: 'ready', image: current.image } as const) : ({ status: 'failed' } as const)) : ({ status: 'loading' } as const)
}

function Segment({ source, onChange }: { source: boolean; onChange: (source: boolean) => void }) {
  const t = useTheme()
  const [hover, setHover] = useState<boolean | null>(null)
  const { rowRef, tab, pill } = useSlidingPill(source ? 'source' : 'preview', 2)
  return <div ref={rowRef} testId="diagram-view" role="group" aria-label="Diagram view" style={{ position: 'relative', display: 'flex', gap: 2, padding: 2, borderRadius: 8, backgroundColor: t.buttonSecondary }}>
    <Pill pill={pill} top={2} height={27.6} style={{ borderRadius: 6, backgroundColor: t.v('--sidebar-accent-active'), boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.08)' } }} />
    {[false, true].map(value => <div key={String(value)} ref={tab(value ? 'source' : 'preview')} testId={value ? 'diagram-source' : 'diagram-preview'} role="button" aria-pressed={source === value} aria-label={value ? 'Show diagram source' : 'Show diagram'}
      onClick={() => onChange(value)} onMouseEnter={() => setHover(value)} onMouseLeave={() => setHover(h => (h === value ? null : h))}
      style={{ display: 'flex', alignItems: 'center', height: 27.6, paddingLeft: 10, paddingRight: 10, borderRadius: 6, cursor: 'pointer' }}>
      <Label color={source === value || hover === value ? t.text : t.textSecondary} weight={500} lineHeight={19.6}>{value ? 'Source' : 'Preview'}</Label>
    </div>)}
  </div>
}

export const MermaidBlock = memo(function MermaidBlock({ code, source, onSource }: { code: string; source: boolean; onSource: (source: boolean) => void }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const dark = t.variant === 'dark'
  const diagram = useDiagram(code, dark)
  const [expanded, setExpanded] = useState(false)
  const [width, setWidth] = useState(lastWidth)
  const node = useRef<PublicInstance | null>(null)
  const [mounted, setMounted] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!mounted) return
    return observeElementBounds(renderer, mounted.id, event => { if (event.rect && Math.abs(event.rect.width - lastWidth) >= 1) { lastWidth = event.rect.width; setWidth(event.rect.width) } })
  }, [renderer, mounted])
  const image = diagram.status === 'ready' ? diagram.image : null
  const showImage = !!image && !source
  const inner = Math.max(40, width - 2 * CANVAS.side)
  const imageHeight = image ? Math.min(CANVAS.maxHeight, inner * image.height / image.width) : 0
  const outline = ink(t, 0.1)
  const chunks = lineChunks(code)
  return <div ref={el => { node.current = el; setMounted(el) }} testId="mermaid-block" data-state={diagram.status} style={{ display: 'flex', flexDirection: 'column', borderRadius: CODE.radius, overflow: 'hidden', backgroundColor: t.codeSurface }}>
    <div testId="code-header" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}>
      <div style={{ display: 'flex', flexGrow: 1, minWidth: 0, alignItems: 'center' }}>
        {image ? <Segment source={source} onChange={onSource} /> : <Label color={muted(t)} style={{ paddingLeft: 4 }}>{diagram.status === 'loading' ? 'Rendering diagram…' : 'Mermaid source'}</Label>}
      </div>
      {image && <div testId="diagram-expand" role="button" aria-label="Expand diagram" onClick={() => setExpanded(true)} style={{ display: 'flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
        <Icon source={T.expand} size={14} color={muted(t)} />
      </div>}
      <CopyAction text={code} testId="code-copy" />
    </div>
    {showImage
      ? <div testId="diagram-canvas" role="region" aria-label="Mermaid diagram" style={{ display: 'flex', flexDirection: 'column', paddingTop: CANVAS.top, paddingLeft: CANVAS.side, paddingRight: CANVAS.side, paddingBottom: CANVAS.bottom }}>
        <img testId="diagram-image" src={image!.path} alt="Mermaid diagram" objectFit="contain" style={{ width: inner, height: imageHeight, borderRadius: 6, borderWidth: 1, borderColor: outline }} />
      </div>
      : chunks.slice(0, 1).map((chunk, i) => <CodeChunk key={i} text={chunk} language="mermaid" wrap={false} />)}
    {diagram.status === 'failed' && <div testId="diagram-note" role="status" style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 8 }}>
      <Label color={muted(t)} lineHeight={21}>Preview unavailable. You can still copy the source.</Label>
    </div>}
    {expanded && image && <ExpandedDiagram image={image} onClose={() => setExpanded(false)} />}
  </div>
})

/** The expanded view: a dialog of at most min(90vw, 1200px) with the diagram contained in 75% of the window height. */
function ExpandedDiagram({ image, onClose }: { image: DiagramImage; onClose: () => void }) {
  useTranscriptRowLease(true)
  const t = useTheme()
  const size = useNativeWindowSize()
  const dialog = Math.min(size.width * 0.9, 1200), inner = dialog - 32
  const height = Math.min(size.height * 0.75, inner * image.height / image.width)
  return <Dialog width={dialog} onClose={onClose} testId="diagram-expanded">
    <div style={{ display: 'flex', flexDirection: 'column', padding: 16 }}>
      <Label color={t.text} weight={600} style={{ paddingRight: 32 }}>Diagram</Label>
      <div style={{ paddingTop: 12 }}>
        <img src={image.path} alt="Mermaid diagram" objectFit="contain" style={{ width: inner, height, borderRadius: 8, borderWidth: 1, borderColor: ink(t, 0.1) }} />
      </div>
    </div>
  </Dialog>
}
