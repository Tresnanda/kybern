// What a Mermaid fence shows when its picture cannot be drawn. The renderer is a hidden web document, so without an embedded
// web view (`webHost.available` false) every diagram stays its source; a diagram that failed to draw says so differently.
export type DiagramStatus = 'loading' | 'ready' | 'failed' | 'unsupported'

/** The label in the code header while there is no picture to switch to. */
export function diagramLabel(status: DiagramStatus): string {
  return status === 'loading' ? 'Rendering diagram…' : status === 'unsupported' ? 'Mermaid diagram' : 'Mermaid source'
}
/** The note under the source, or null when there is nothing to explain. */
export function diagramNote(status: DiagramStatus): string | null {
  if (status === 'unsupported') return "Diagrams can't be drawn on this platform yet. Copy the source to view it elsewhere."
  if (status === 'failed') return 'Preview unavailable. You can still copy the source.'
  return null
}
