// A settled ```mermaid fence (`components/kybern/MermaidBlock.tsx`): the code header carries a
// Preview/Source switch with a sliding pill and an expand button; the preview is the rendered
// diagram as an image (`mermaid.ts`), failures stay readable as source with a note.
import { useTranscriptRowLease } from './Window.tsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Label, ink, useTheme } from '../ui.tsx'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { CopyAction } from './bubble.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { CODE, muted } from './kit.tsx'
import { CodeChunk, lineChunks } from './markdown.tsx'
import { T } from './glyphs.ts'
import { usePaneAccess } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { renderMermaid, type DiagramImage } from './mermaid.ts'

/** `.chat-diagram-canvas`: padding .5rem 1rem 1rem; the image is at most 24rem tall. */
const CANVAS = { top: 8, side: 16, bottom: 16, maxHeight: 384 }
let lastWidth = 640

export function useDiagram(code: string, dark: boolean) {
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
  return <Segmented testId="diagram" aria-label="Diagram view" size="sm" value={source ? 'source' : 'preview'} onChange={value => onChange(value === 'source')} options={[{ value: 'preview', label: 'Preview' }, { value: 'source', label: 'Source' }]} />
}

export const MermaidBlock = memo(function MermaidBlock({ code, source, onSource }: { code: string; source: boolean; onSource: (source: boolean) => void }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const dark = t.variant === 'dark'
  const diagram = useDiagram(code, dark)
  const pane = usePaneAccess()
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
      {image && <IconButton testId="diagram-expand" label="Open diagram in a tab" icon={T.expand} size="sm" onClick={() => openTabFromPane(pane.id, { kind: 'mermaid', code, title: 'Diagram' })} />}
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

/** A diagram opened as a tab (ADE-54): the rendered image contained in the tab, or its source while it renders or fails. */
export function MermaidTab({ code }: { code: string }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const diagram = useDiagram(code, t.variant === 'dark')
  const [host, setHost] = useState<PublicInstance | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => host ? observeElementBounds(renderer, host.id, e => { if (e.rect) setBox(b => b.width === e.rect!.width && b.height === e.rect!.height ? b : { width: e.rect!.width, height: e.rect!.height }) }) : undefined, [renderer, host])
  const image = diagram.status === 'ready' ? diagram.image : null
  const room = { width: Math.max(40, box.width - 48), height: Math.max(40, box.height - 48) }
  const scale = image ? Math.min(room.width / image.width, room.height / image.height, 2) : 1
  return <div ref={setHost} testId="mermaid-tab" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
    {image ? <img testId="mermaid-tab-image" src={image.path} alt="Mermaid diagram" objectFit="contain" style={{ width: image.width * scale, height: image.height * scale }} />
      : <div style={{ display: 'flex', flexDirection: 'column', alignSelf: 'stretch', flexGrow: 1, minHeight: 0, padding: 24, gap: 8 }}>
        <Label color={muted(t)}>{diagram.status === 'loading' ? 'Rendering diagram…' : 'Preview unavailable. You can still copy the source.'}</Label>
        {lineChunks(code).slice(0, 1).map((chunk, i) => <CodeChunk key={i} text={chunk} language="mermaid" wrap={false} />)}
      </div>}
    <div style={{ position: 'absolute', top: 12, right: 12 }}><CopyAction text={code} testId="mermaid-tab-copy" /></div>
  </div>
}
