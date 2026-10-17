// A native window with the shared editor on a sample note, for checks and captures.
// KYBERN_EDITOR_SAMPLE picks the document; KYBERN_EDITOR_VARIANT=compact the compact look.
// The left margin holds small controls that drive what automation cannot type: the
// input method path (marked text, commit) and reading the editor's state and layout.
import '../native/local-build.ts'
import { render, useGpuix, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { RichEditor, type EditorState, type RichEditorHandle } from './RichEditor.tsx'
import { SAMPLES } from './samples.ts'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'

const sample = SAMPLES[process.env.KYBERN_EDITOR_SAMPLE ?? 'all'] ?? SAMPLES.all!
const compact = process.env.KYBERN_EDITOR_VARIANT === 'compact'
/** The sample's task reference, so its chip is live (key and status) and opens on click. */
const LAB_TASKS = { '11111111-1111-4111-8111-111111111111': { id: '11111111-1111-4111-8111-111111111111', key: 'ADE-14', title: 'Review the design', status: 'needs_review' } } as unknown as Record<string, TaskItem>

function Lab() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const editor = useRef<RichEditorHandle>(null)
  const scroller = useRef<PublicInstance>(null)
  const root = useRef<PublicInstance>(null)
  const [source, setSource] = useState(sample)
  const [links, setLinks] = useState<string[]>([])
  const [debug, setDebug] = useState('')
  const [result, setResult] = useState('')
  const publish = (state?: EditorState) => setDebug(JSON.stringify({ state: state ?? editor.current?.state(), layout: editor.current?.command({ cmd: 'layout' }), selection: editor.current?.command({ cmd: 'getSelection' }) }))
  const run = (cmd: Record<string, unknown>) => () => { setResult(JSON.stringify(editor.current?.command(cmd) ?? null)); publish() }
  const control = (id: string, action: () => void) => <div key={id} testId={id} onClick={action} style={{ width: 96, height: 18, marginBottom: 4, borderRadius: 4, backgroundColor: t.buttonSecondary }}><Label color={t.textSecondary} size={9} style={{ pointerEvents: 'none' }}>{id}</Label></div>
  return <div ref={root} testId="editor-lab" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexDirection: 'column', position: 'absolute', left: 8, top: 48, width: 100 }}>
      {control('lab-ime-n', run({ cmd: 'ime', op: 'mark', text: 'ｎ' }))}
      {control('lab-ime-ni', run({ cmd: 'ime', op: 'mark', text: 'に' }))}
      {control('lab-ime-nihon', run({ cmd: 'ime', op: 'mark', text: '日本' }))}
      {control('lab-ime-commit', run({ cmd: 'ime', op: 'commit', text: '日本' }))}
      {control('lab-stats', run({ cmd: 'stats' }))}
      {control('lab-publish', () => publish())}
      {control('lab-focus-end', run({ cmd: 'focus', at: 'end' }))}
      {control('lab-blur', () => renderer?.blur?.())}
    </div>
    <div ref={scroller} testId="editor-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexGrow: 1, overflow: 'scroll', paddingTop: 48, paddingBottom: 96 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: compact ? 420 : 640 }}>
        <RichEditor ref={editor} testId="editor" value={sample} epoch={0} variant={compact ? 'compact' : 'page'} onChange={setSource}
          onOpenLink={href => setLinks(l => [...l, href])} images={null} scroller={scroller} viewport={root} onState={publish} tasks={LAB_TASKS} />
      </div>
    </div>
    <text testId="editor-source" style={{ position: 'absolute', left: 0, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{JSON.stringify(source)}</text>
    <text testId="editor-links" style={{ position: 'absolute', left: 12, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{JSON.stringify(links)}</text>
    <text testId="editor-debug" style={{ position: 'absolute', left: 24, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{debug}</text>
    <text testId="editor-result" style={{ position: 'absolute', left: 36, bottom: 0, width: 10, height: 10, opacity: 0, fontSize: 1 }}>{result}</text>
  </div>
}
render(<Lab />, { title: 'Rich editor lab', width: 900, height: 860, focus: false })
