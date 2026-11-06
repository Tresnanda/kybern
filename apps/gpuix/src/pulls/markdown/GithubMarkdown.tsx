// Markdown of an issue or a pull request (descriptions, comments, review comments) with its images drawn. `githubSegments`
// splits the images out; text pieces render as before (native Markdown, or a worker-parsed document for long descriptions),
// and each image is a reply image (`ResponseImage`: sized from its header, click to open, Open in tab) loaded by
// `useGithubImage`. An image that cannot load shows its caption and why, never its HTML. `GithubImages` says which issue or
// pull request the images belong to.
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react'
import type { MarkdownProps } from '@gpuix/react'
import { DocumentMarkdown } from '../../native/markdownDocument.tsx'
import { ResponseImage } from '../../transcript/images.tsx'
import { ImageCard } from '../../transcript/ThreadImage.tsx'
import { column } from '../../usage/controls.tsx'
import { useBoxWidth } from '../../usage/useBoxWidth.ts'
import { loadable, useGithubImage, type GithubImageContext } from './githubImage.ts'
import { githubSegments } from './segments.ts'

/** The widest and tallest an image is drawn; larger ones open full size on a click. */
const IMAGE_WIDTH = 480
const IMAGE_HEIGHT = 560
/** The margin native Markdown keeps between blocks (`transcript/markdown.tsx`). */
const BLOCK_GAP = 10

const Context = createContext<GithubImageContext | null>(null)

/** The issue or pull request whose Markdown is drawn inside. */
export function GithubImages({ value, children }: { value: GithubImageContext; children: ReactNode }) {
  const stable = useMemo(() => value, [value.projectId, value.number, value.repo])
  return <Context.Provider value={stable}>{children}</Context.Provider>
}

/** `room`: the width of the column the image sits in (0 until measured), so a wide image shrinks to a narrow column. */
export function GithubImage({ source, alt, width, height, room = 0 }: { source: string; alt: string; width?: number; height?: number; room?: number }) {
  const context = useContext(Context)
  const label = alt || 'Image'
  const image = useGithubImage(context, source)
  if (!loadable(source)) return <ImageCard testId="github-image" label={label} reason="This image source cannot be shown." />
  if (image.image) return <ResponseImage source={image.image.source} label={label} maxWidth={Math.min(IMAGE_WIDTH, width ?? IMAGE_WIDTH, room > 0 ? room : IMAGE_WIDTH)} maxHeight={Math.min(IMAGE_HEIGHT, height ?? IMAGE_HEIGHT)} />
  if (!image.failure) return <ImageCard testId="github-image" label={label} loading />
  const retryable = image.failure.status !== 413 && image.failure.status !== 415 && image.failure.status !== -1
  return <ImageCard testId="github-image" label={label} reason={image.failure.reason} onRetry={retryable ? image.retry : undefined} />
}

/**
 * `source` drawn with its images. `document`: a long description, parsed off the render path (`DocumentMarkdown`); otherwise
 * native `<markdown>`. Text without images renders exactly as before, as one element. `ref` reaches the first text piece.
 */
export const GithubMarkdown = memo(function GithubMarkdown({ source, document = false, ref, ...props }: Omit<MarkdownProps, 'source'> & { source: string; document?: boolean; ref?: unknown }) {
  const segments = useMemo(() => githubSegments(source), [source])
  const first = segments.findIndex(segment => segment.kind === 'text')
  const text = (key: string | number, value: string, index: number) => {
    const own = index === first && ref ? { ref } : {}
    return document
      ? <DocumentMarkdown key={key} {...props} {...own} source={value} />
      : <markdown key={key} {...props} {...own} source={value} />
  }
  const [box, room] = useBoxWidth()
  if (segments.length === 1 && segments[0]!.kind === 'text') return text('text', segments[0]!.text, 0)
  return <div ref={box} testId="github-markdown" style={{ ...column, gap: BLOCK_GAP, alignItems: 'flex-start', alignSelf: 'stretch', minWidth: 0 }}>
    {segments.map((segment, i) => segment.kind === 'text'
      ? <div key={i} style={{ ...column, alignSelf: 'stretch' }}>{text(i, segment.text, i)}</div>
      : <GithubImage key={i} source={segment.source} alt={segment.alt} {...(segment.width ? { width: segment.width } : {})} {...(segment.height ? { height: segment.height } : {})} room={room} />)}
  </div>
})
