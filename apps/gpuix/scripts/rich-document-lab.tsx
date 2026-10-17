import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { RichDocument } from '../src/notes/RichDocument.tsx'
import { Label, useTheme } from '../src/ui.tsx'

// A real native image host, without a daemon, network, file grants or user data.
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
export const initial = `![Fixture image](${pixel} "preserved title")\n\n\`\`\`ts\nconst code = "literal **text**"\n\`\`\`\n\nAfter **bold** and [link](https://example.com "title").\n\n| First | Second |\n| - | - |\n| cell | **value** |`
function Lab() {
  const t = useTheme(), [value, setValue] = useState(initial)
  return <div testId="app-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 24, gap: 12, backgroundColor: t.surface }}>
    <Label color={t.text} size={20}>Mixed native document</Label>
    <RichDocument testId="mixed" value={value} onChange={setValue} columnWidth={240} minRows={1} maxRows={8} style={{ width: 680, fontSize: 15, lineHeight: 24, color: t.text }} theme={{ text: t.text, caret: t.text }} />
    <text testId="source" style={{ color: t.textSecondary, fontSize: 10 }}>{JSON.stringify(value)}</text>
  </div>
}
render(<Lab />, { title: 'Kybern mixed rich editor verification', width: 760, height: 900, focus: false })
