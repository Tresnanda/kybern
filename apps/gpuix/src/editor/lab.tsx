// A native window with the shared editor on a sample note, for checks and captures.
// KYBERN_EDITOR_SAMPLE picks the document; KYBERN_EDITOR_VARIANT=compact the compact look.
import '../native/local-build.ts'
import { render, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
import { useTheme } from '../ui.tsx'
import { RichEditor, type RichEditorHandle } from './RichEditor.tsx'
import { SAMPLES } from './samples.ts'

const sample = SAMPLES[process.env.KYBERN_EDITOR_SAMPLE ?? 'all'] ?? SAMPLES.all!
const compact = process.env.KYBERN_EDITOR_VARIANT === 'compact'

function Lab() {
  const t = useTheme()
  const editor = useRef<RichEditorHandle>(null)
  const scroller = useRef<PublicInstance>(null)
  const [source, setSource] = useState(sample)
  const [links, setLinks] = useState<string[]>([])
  return <div testId="editor-lab" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div ref={scroller} testId="editor-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexGrow: 1, overflow: 'scroll', paddingTop: 48, paddingBottom: 96 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: compact ? 420 : 640 }}>
        <RichEditor ref={editor} testId="editor" value={sample} epoch={0} variant={compact ? 'compact' : 'page'} onChange={setSource}
          onOpenLink={href => setLinks(l => [...l, href])} images={null} scroller={scroller} />
      </div>
    </div>
    <text testId="editor-source" style={{ position: 'absolute', left: 0, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{JSON.stringify(source)}</text>
    <text testId="editor-links" style={{ position: 'absolute', left: 12, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{JSON.stringify(links)}</text>
  </div>
}
render(<Lab />, { title: 'Rich editor lab', width: 900, height: 1000, focus: false })
