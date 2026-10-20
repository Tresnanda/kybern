/** The native Markdown document API is additive. Older addons keep the existing
 * Markdown host; a newer addon supplies canonical blocks and append parsing. */
export interface StreamDocumentRevision {
  id: string
  revision: number
  stablePrefixBlocks: number
  parsedBytes: number
}
export interface StreamDocumentRenderer {
  createMarkdownDocument(source: {text: string}): Promise<StreamDocumentRevision>
  updateMarkdownDocument(id: string, source: {text: string; expectedRevision: number}): Promise<StreamDocumentRevision>
  releaseMarkdownDocument(id: string): void
}

/** One native worker request and one latest pending string, owned by one row.
 * Superseded replies advance the private revision without painting stale text.
 * A release also handles creation that completes after the owner disappeared. */
export function streamDocumentOwner(renderer: StreamDocumentRenderer, publish: (revision: StreamDocumentRevision, text: string) => void, failed: (error: unknown) => void) {
  let disposed = false, running = false, pending: string | undefined
  let document: StreamDocumentRevision | undefined, source: string | undefined
  const release = () => {
    if (document) { renderer.releaseMarkdownDocument(document.id); document = undefined }
  }
  const drain = async () => {
    if (running || disposed) return
    running = true
    try {
      while (!disposed && pending !== undefined) {
        const text = pending
        pending = undefined
        if (document && text === source) { publish(document, text); continue }
        const next = document
          ? await renderer.updateMarkdownDocument(document.id, {text, expectedRevision: document.revision})
          : await renderer.createMarkdownDocument({text})
        document = next
        source = text
        if (disposed) { release(); break }
        if (pending === undefined || pending === text) { pending = undefined; publish(next, text) }
      }
    } catch (error) {
      if (!disposed) { disposed = true; pending = undefined; release(); failed(error) }
    } finally { running = false }
  }
  return {
    enqueue(text: string) { if (!disposed) { pending = text; void drain() } },
    dispose() { disposed = true; pending = undefined; release() },
  }
}
