import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { ThemeProvider, Label, useTheme } from '../ui.tsx'
import { renderMermaid, type DiagramImage } from './mermaid.ts'
const SOURCES: Record<string, string> = {
  flow: 'flowchart LR\n  A[Composer] --> B{Send}\n  B -->|Enter| C[Daemon]\n  B -->|Queue| D[Queued]\n  C --> E[Provider]',
  sequence: 'sequenceDiagram\n  User->>Daemon: send\n  Daemon-->>User: events',
  invalid: 'flowchart LR\n  A -->',
}
function Fixture() {
  const t = useTheme()
  const [state, setState] = useState<Record<string, string>>({})
  const [image, setImage] = useState<DiagramImage | null>(null)
  useEffect(() => {
    const control = new AbortController()
    ;(async () => {
      const started = performance.now()
      const results = await Promise.all(Object.entries(SOURCES).map(async ([name, code]) => [name, await renderMermaid(code, t.variant === 'dark', control.signal)] as const))
      const again = performance.now()
      const cached = await renderMermaid(SOURCES.flow!, t.variant === 'dark', control.signal)
      setImage(results[0]![1])
      setState({ ...Object.fromEntries(results.map(([name, result]) => [name, result ? `${result.width}x${result.height}` : 'none'])), first: String(Math.round(again - started)), cached: String(Math.round(performance.now() - again)), cachedSame: String(cached?.path === results[0]![1]?.path) })
    })()
    return () => control.abort()
  }, [])
  return <div testId="mermaid-fixture" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16, width: '100%', height: '100%', backgroundColor: t.surface }}>
    {Object.entries(state).map(([k, v]) => <Label key={k} color={t.text}>{`${k}: ${v}`}</Label>)}
    {image && <img testId="diagram" src={image.path} alt="diagram" objectFit="contain" style={{ width: 800, height: 800 * image.height / image.width }} />}
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Mermaid', width: 900, height: 700, focus: false })
