import { useMemo } from 'react'
import path from 'node:path'
import { FencedMarkdown, splitImages } from '../transcript/markdown.tsx'
import { ThreadImage } from '../transcript/ThreadImage.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { useTheme } from '../ui.tsx'
import { absoluteThreadFile } from '../transcript/threadFiles.ts'
import { imageSource } from '../../../../packages/kybern-client/src/responseImages.ts'
export function MarkdownPreview({ source, threadId, file }: { source: string; threadId?: string; file: string }) {
  const t = useTheme(), parts = useMemo(() => splitImages(source), [source])
  const base = threadId ? absoluteThreadFile(threadId, file) : null
  const p = /^[a-z]:[\\/]/i.test(base ?? '') ? path.win32 : path.posix
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {parts.map((part, i) => part.kind === 'text' ? <FencedMarkdown key={i} document source={part.text} theme={cachedMarkdownTheme(t)} /> :
      <ThreadImage key={i} threadId={threadId ?? null} source={base && imageSource(part.source)?.kind === 'local' && !part.source.startsWith('~/') && !part.source.startsWith('file:') ? p.resolve(p.dirname(base), part.source) : part.source} alt={part.alt} />)}
  </div>
}
