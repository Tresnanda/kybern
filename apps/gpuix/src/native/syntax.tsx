import { createElement } from 'react'
import type { CodeProps } from '@gpuix/react'
export interface SyntaxDocument { id: string; revision: number; lineCount: number }
export interface SyntaxSource { text: string; language?: string; path?: string }
interface SyntaxRenderer {
  createSyntaxDocument(source: SyntaxSource): Promise<SyntaxDocument>
  updateSyntaxDocument(id: string, source: { text: string; expectedRevision: number }): Promise<SyntaxDocument>
  releaseSyntaxDocument(id: string): void
  getSyntaxDocumentText(id: string, revision: number): string
}
function native(renderer: object): SyntaxRenderer {
  if (typeof (renderer as SyntaxRenderer).createSyntaxDocument !== 'function') throw Error('Syntax documents require the current Kybern native build')
  return renderer as SyntaxRenderer
}
export const createSyntaxDocument = (renderer: object, source: SyntaxSource) => native(renderer).createSyntaxDocument(source)
export const updateSyntaxDocument = (renderer: object, id: string, source: { text: string; expectedRevision: number }) => native(renderer).updateSyntaxDocument(id, source)
export const releaseSyntaxDocument = (renderer: object, id: string) => native(renderer).releaseSyntaxDocument(id)
export const getSyntaxDocumentText = (renderer: object, document: SyntaxDocument) => native(renderer).getSyntaxDocumentText(document.id, document.revision)
export type VirtualCodeProps = Omit<CodeProps, 'code'> & {
  document: string; revision: number; startLine: number; endLine: number
}
/** Render a line range from an already parsed immutable document revision. */
export function VirtualCode(props: VirtualCodeProps) {
  if (![props.startLine, props.endLine, props.revision].every(Number.isSafeInteger)
    || props.startLine < 0 || props.endLine < props.startLine || props.revision < 1) {
    throw Error('Code range must contain nonnegative integer lines with startLine <= endLine and a positive revision')
  }
  return createElement('code', props)
}
