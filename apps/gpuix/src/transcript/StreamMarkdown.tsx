import {useGpuixRequired, type MarkdownProps} from '@gpuix/react'
import {createElement, memo, useEffect, useRef, useState} from 'react'
import {streamDocumentOwner, type StreamDocumentRenderer, type StreamDocumentRevision} from './streamDocument.ts'

/** The source host is also the compatibility/error fallback. A document update
 * retains this host, the canonical AST prefix, selection identity and the native
 * paint-only caret/fade theme. Only the changing tail is parsed by the worker. */
export const StreamMarkdown = memo(function StreamMarkdown(props: MarkdownProps) {
  const renderer = useGpuixRequired() as unknown as StreamDocumentRenderer
  const source = props.source ?? ''
  const latest = useRef(source)
  latest.current = source
  const capable = process.env.KYBERN_STREAM_DOCUMENT !== '0'
    && typeof renderer.createMarkdownDocument === 'function'
    && typeof renderer.updateMarkdownDocument === 'function'
    && typeof renderer.releaseMarkdownDocument === 'function'
  const [ready, setReady] = useState<StreamDocumentRevision | null>(null)
  const [failed, setFailed] = useState(false)
  const [owner, setOwner] = useState<ReturnType<typeof streamDocumentOwner> | null>(null)
  useEffect(() => {
    if (!capable) return
    const actor = streamDocumentOwner(renderer, (revision, text) => {
      if (process.env.KYBERN_STREAM_DOCUMENT_STATS === '1') console.error('[stream-document]', JSON.stringify(revision))
      // A prop render can precede its enqueue effect. Do not replace the
      // source fallback with an older worker reply during that interval.
      if (latest.current === text) setReady(revision)
    }, () => { setReady(null); setFailed(true) })
    setOwner(actor)
    return () => actor.dispose()
  }, [renderer, capable])
  useEffect(() => { owner?.enqueue(source) }, [owner, source])
  return createElement('markdown', {
    ...props,
    ...(capable && ready && !failed ? {source: '', document: ready.id, revision: ready.revision} : {}),
  })
})
