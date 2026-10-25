import { createElement } from 'react'
import type { TextareaProps } from '@gpuix/react'

/**
 * `<textarea codeEditor>` (`native/upstream/packages/native/src/code_editor.rs`): the native multiline editor (selection, IME, clipboard, undo) with
 * Syntect colours from a registered syntax document, a line-number gutter per logical line, optional no-wrap horizontal
 * scrolling and viewport culling. It fills its box and scrolls inside it. While a reparse of the edited text is pending, the
 * last revision's colours stay outside the edited span. `revealLine` is `"<1-based line>:<nonce>"`: a new value scrolls that line
 * near the top and puts the caret on it.
 */
export type CodeEditorProps = TextareaProps & {
  testId: string
  syntaxDocument?: string
  syntaxRevision?: number
  softWrap?: boolean
  showLineNumbers?: boolean
  revealLine?: string
}
export function CodeEditorInput(props: CodeEditorProps) {
  return createElement('textarea', { ...props, codeEditor: true })
}
