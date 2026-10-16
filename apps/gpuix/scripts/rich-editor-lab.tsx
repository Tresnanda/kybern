import '../src/native/local-build.ts'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
import { RichTextarea, type RichTextareaHandle } from '../src/notes/RichTextarea.tsx'
import { TokenTextarea, type TokenTextareaHandle } from '../src/composer/TokenTextarea.tsx'
import { nativeCapabilities } from '../src/native/api.ts'
import { useTheme, Label } from '../src/ui.tsx'

function Lab() {
  const t = useTheme(), renderer = useGpuixRequired()
  const [body, setBody] = useState('Write **bold** and *italic* with [a link](https://example.com).\n\n')
  const [message, setMessage] = useState('Read @"Editor notes" with @Computer please')
  const [result, setResult] = useState('')
  const rich = useRef<RichTextareaHandle>(null), richNode = useRef<PublicInstance>(null)
  const token = useRef<TokenTextareaHandle>(null), tokenNode = useRef<PublicInstance>(null)
  const control = (id: string, action: () => void) => <div testId={id} onClick={action} style={{ padding: 8, backgroundColor: t.buttonSecondary, borderRadius: 6 }}><Label color={t.text} style={{ pointerEvents: 'none' }}>{id}</Label></div>
  return <div testId="app-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', gap: 20, padding: 32, backgroundColor: t.surface }}>
    <Label color={t.text} size={24}>Formatted native editing</Label>
    <RichTextarea testId="rich" editorRef={rich} nativeRef={richNode} value={body} onChange={setBody} minRows={2} maxRows={10} style={{ width: 650, fontSize: 16.1538, lineHeight: 25.846, color: t.text }} theme={{ text: t.text, caret: t.text }} />
    <div style={{ display: 'flex', gap: 8 }}>
      {control('select-bold', () => { if (richNode.current) { renderer.focusElement?.(richNode.current.id); nativeCapabilities(renderer).setInputSelection(richNode.current.id, 6, 10, false) } })}
      {control('bold', () => rich.current?.mark('**'))}
      {control('heading', () => rich.current?.block('h2'))}
      {control('rich-selection', () => setResult(JSON.stringify(rich.current?.selection())))}
      {control('select-all-rich', () => { if (richNode.current) { renderer.focusElement?.(richNode.current.id); nativeCapabilities(renderer).setInputSelection(richNode.current.id, 0, 44, false) } })}
    </div>
    <Label color={t.textSecondary} size={12}>Persisted Markdown</Label>
    <text testId="source" style={{ color: t.textSecondary, fontSize: 12 }}>{JSON.stringify(body)}</text>
    <Label color={t.text} size={20}>Composer references stay inline</Label>
    <TokenTextarea testId="tokens" editorRef={token} nativeRef={tokenNode} references={[{ token: '@"Editor notes"', label: 'Editor notes' }, { token: '@Computer', label: 'Computer' }]} value={message} onChange={event => setMessage(event.value ?? '')} minRows={2} maxRows={6} style={{ width: 650, color: t.text, fontSize: 14, lineHeight: 19.6 }} theme={{ text: t.text, caret: t.text }} />
    <div style={{ display: 'flex', gap: 8 }}>
      {control('before-token', () => { if (tokenNode.current) { renderer.focusElement?.(tokenNode.current.id); nativeCapabilities(renderer).setInputSelection(tokenNode.current.id, 5, 5, false) } })}
      {control('select-token-range', () => { if (tokenNode.current) { renderer.focusElement?.(tokenNode.current.id); nativeCapabilities(renderer).setInputSelection(tokenNode.current.id, 6, 10, true) } })}
      {control('token-selection', () => setResult(JSON.stringify(token.current?.selection())))}
      {control('pick-token', () => { token.current?.edit(0, 4, '@Computer'); if (tokenNode.current) renderer.focusElement?.(tokenNode.current.id) })}
    </div>
    <text testId="message" style={{ color: t.textSecondary, fontSize: 12 }}>{JSON.stringify(message)}</text>
    <text testId="result" style={{ color: t.textSecondary, fontSize: 12 }}>{result}</text>
  </div>
}
render(<Lab />, { title: 'Kybern rich editor verification', width: 760, height: 640, focus: false })
