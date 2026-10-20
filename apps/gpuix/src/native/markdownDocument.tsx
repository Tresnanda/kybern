import { useGpuixRequired, type MarkdownProps } from '@gpuix/react'
import { createElement, memo, useEffect, useRef, useState } from 'react'
export interface MarkdownBlock {
  id: string; index: number; kind: string; startByte: number; endByte: number
}
export interface MarkdownDocument {
  id: string; revision: number; blocks: MarkdownBlock[]; stablePrefixBlocks: number; parsedBytes: number
}
export interface MarkdownLayout { width: number; scale: number; startBlock: number; blocks: { index: number; y: number; height: number }[] }
interface MarkdownRenderer {
  createMarkdownDocument(source: { text: string }): Promise<MarkdownDocument>
  updateMarkdownDocument(id: string, source: { text: string; expectedRevision: number }): Promise<MarkdownDocument>
  releaseMarkdownDocument(id: string): void
  getMarkdownDocumentText(id: string, revision: number): string
  getMarkdownDocumentLayout(id: string, revision: number): MarkdownLayout | null
  getMarkdownDocumentStats(): { documents: number; sourceBytes: number; pending: number }
}
function native(renderer: object): MarkdownRenderer {
  if (typeof (renderer as MarkdownRenderer).createMarkdownDocument !== 'function') throw Error('Markdown documents require the current Kybern native build')
  return renderer as MarkdownRenderer
}
export const createMarkdownDocument = (renderer: object, source: { text: string }) => native(renderer).createMarkdownDocument(source)
export const updateMarkdownDocument = (renderer: object, id: string, source: { text: string; expectedRevision: number }) => native(renderer).updateMarkdownDocument(id, source)
export const releaseMarkdownDocument = (renderer: object, id: string) => native(renderer).releaseMarkdownDocument(id)
export const getMarkdownDocumentText = (renderer: object, document: MarkdownDocument) => native(renderer).getMarkdownDocumentText(document.id, document.revision)
export const getMarkdownDocumentLayout = (renderer: object, document: MarkdownDocument) => native(renderer).getMarkdownDocumentLayout(document.id, document.revision)
export const getMarkdownDocumentStats = (renderer: object) => native(renderer).getMarkdownDocumentStats()
/** Own a worker-parsed document for exactly the lifetime of this mounted body.
 * Native measured block geometry follows source, width, scale and theme changes.
 * The parent remains the only vertical scroller.
 */
export const DocumentMarkdown = memo(function DocumentMarkdown(props: MarkdownProps) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState<MarkdownDocument | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const source = props.source ?? ''
  const owner = useRef<{
    disposed: boolean; document?: MarkdownDocument; latest?: string; running: boolean; enqueue: (source: string) => void
  } | null>(null)
  useEffect(() => {
    const actor = { disposed: false, document: undefined as MarkdownDocument | undefined, latest: undefined as string | undefined, running: false,
      enqueue: (_source: string) => {} }
    const drain = async () => {
      if (actor.running || actor.disposed) return
      actor.running = true
      try {
        while (!actor.disposed && actor.latest != null) {
          const text = actor.latest
          actor.latest = undefined
          const next = actor.document
            ? await updateMarkdownDocument(renderer, actor.document.id, { text, expectedRevision: actor.document.revision })
            : await createMarkdownDocument(renderer, { text })
          if (actor.disposed) { releaseMarkdownDocument(renderer, next.id); break }
          actor.document = next
          if (actor.latest == null) setReady(next)
        }
      } catch (error) {
        if (!actor.disposed) setError(error instanceof Error ? error : Error(String(error)))
      } finally { actor.running = false }
    }
    actor.enqueue = text => { actor.latest = text; setError(null); void drain() }
    owner.current = actor
    return () => {
      actor.disposed = true
      if (actor.document) releaseMarkdownDocument(renderer, actor.document.id)
      if (owner.current === actor) owner.current = null
    }
  }, [renderer])
  useEffect(() => { owner.current?.enqueue(source) }, [renderer, source])
  if (error) throw error
  if (!ready) return null
  return createElement('markdown', { ...props, style: { userSelect: 'text', ...props.style }, source: '', document: ready.id, revision: ready.revision })
})

export type MarkdownRangeProps = Omit<MarkdownProps, 'source'> & {
  document: string; revision: number; startBlock?: number; endBlock?: number
}
/** Ranges address the canonical AST, preserving global references and selection.
 * Geometry is measured natively; the caller owns one parent vertical scroller.
 */
export function MarkdownRange(props: MarkdownRangeProps) {
  if (!Number.isSafeInteger(props.revision) || props.revision < 1 ||
    [props.startBlock, props.endBlock].some(value => value != null && (!Number.isSafeInteger(value) || value < 0)) ||
    (props.startBlock != null && props.endBlock != null && props.startBlock > props.endBlock)) throw Error('Invalid Markdown document range')
  return createElement('markdown', props)
}
