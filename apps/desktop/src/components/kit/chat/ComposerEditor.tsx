// The composer's input: plain text with inline tokens (`@Computer`, `@"Thread"`,
// `$skill`, `@file`, `@image1`) shown as real elements, icon and label, laid out
// exactly like sent messages.
//
// The text string stays the single source of truth for the composer. This
// component owns its DOM rather than letting React render the editable
// children: typing edits text nodes in place, and the DOM is rebuilt only when
// the token layout changes or the value is replaced (a menu pick, a send), after
// which the caret is restored at the same text offset. Tokens are atomic
// (`contenteditable=false`), so arrows skip them and Backspace removes one whole.

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { InlineTokenIcon } from "@/components/kybern/InlineToken"
import { inlineTokenLabel, type InlineTokenKind } from "@/lib/inlineTokenLabel"
import { cn } from "@/lib/utils"

export type EditorSegment = { kind: "text"; text: string } | { kind: "token"; text: string; token: InlineTokenKind }

export interface ComposerEditorHandle {
  focus: (options?: FocusOptions) => void
  /** Collapse the selection at a text offset. */
  setCaret: (offset: number) => void
  readonly element: HTMLDivElement | null
}

interface ComposerEditorProps {
  value: string
  segments: readonly EditorSegment[]
  placeholder?: string
  disabled?: boolean
  className?: string
  onChange: (value: string, caret: number) => void
  onCaret: (caret: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** Handle file pastes; return true when the paste was consumed. */
  onPasteFiles?: (event: ClipboardEvent<HTMLDivElement>) => boolean
}

const TOKEN_ATTRIBUTE = "data-token"
const TAIL_ATTRIBUTE = "data-tail"
const HISTORY_LIMIT = 200
const TYPING_MERGE_MS = 800

/** The text a run of editor nodes stands for: raw token text, `\n` for line breaks. */
function serializeNodes(nodes: Iterable<Node>, into: { text: string }): void {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      into.text += node.nodeValue ?? ""
      continue
    }
    if (!(node instanceof Element)) continue
    const raw = node.getAttribute(TOKEN_ATTRIBUTE)
    if (raw !== null) {
      into.text += raw
    } else if (node.tagName === "BR") {
      if (!node.hasAttribute(TAIL_ATTRIBUTE)) into.text += "\n"
    } else {
      // Pasted or browser-made blocks start a new line.
      if ((node.tagName === "DIV" || node.tagName === "P") && into.text && !into.text.endsWith("\n")) into.text += "\n"
      serializeNodes(node.childNodes, into)
    }
  }
}

/** The raw composer text held by an editor element (also used by perf fixtures). */
export function composerEditorValue(root: Node): string {
  const into = { text: "" }
  serializeNodes(root.childNodes, into)
  // A lone browser placeholder `<br>` in an empty editor is not a newline.
  return into.text === "\n" && root.childNodes.length === 1 ? "" : into.text
}

/** A caret inside a token's label snaps to the token's nearer edge. */
function outsideTokens(root: HTMLElement, container: Node, offset: number): [Node, number] {
  const element = container instanceof Element ? container : container.parentElement
  const token = element?.closest(`[${TOKEN_ATTRIBUTE}]`)
  if (!token || token === root || !root.contains(token) || !token.parentNode) return [container, offset]
  const inside = document.createRange()
  inside.selectNodeContents(token)
  inside.setEnd(container, offset)
  const index = Array.prototype.indexOf.call(token.parentNode.childNodes, token) as number
  return [token.parentNode, inside.toString().length === 0 ? index : index + 1]
}

function offsetAt(root: HTMLElement, rawContainer: Node, rawOffset: number): number {
  const [container, offset] = outsideTokens(root, rawContainer, rawOffset)
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(container, offset)
  const into = { text: "" }
  serializeNodes(before.cloneContents().childNodes, into)
  return into.text.length
}

function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = offsetAt(root, range.startContainer, range.startOffset)
  const end = range.collapsed ? start : offsetAt(root, range.endContainer, range.endOffset)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

function placeCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange()
  let remaining = Math.max(0, offset)
  let placed = false
  for (const node of Array.from(root.childNodes)) {
    const raw = node instanceof Element ? node.getAttribute(TOKEN_ATTRIBUTE) : null
    const length =
      node.nodeType === Node.TEXT_NODE ? (node.nodeValue ?? "").length : raw !== null ? raw.length : node instanceof Element && node.tagName === "BR" && !node.hasAttribute(TAIL_ATTRIBUTE) ? 1 : 0
    if (length > 0 && remaining <= length) {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, remaining)
      else if (remaining === 0) range.setStartBefore(node)
      else range.setStartAfter(node)
      placed = true
      break
    }
    remaining -= length
  }
  if (!placed) {
    const tail = root.querySelector(`:scope > br[${TAIL_ATTRIBUTE}]`)
    if (tail) range.setStartBefore(tail)
    else {
      range.selectNodeContents(root)
      range.collapse(false)
    }
  }
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

// Token icons come from React components; render each kind once to markup.
const iconMarkup = new Map<string, string>()
function tokenIcon(kind: InlineTokenKind, text: string): string {
  const extension = kind === "file" || kind === "attachment" ? (text.split(".").at(-1) ?? "") : ""
  const key = `${kind}:${extension}:${text.startsWith("@image")}`
  let markup = iconMarkup.get(key)
  if (markup === undefined) {
    markup = renderToStaticMarkup(<InlineTokenIcon kind={kind} text={text} />)
    iconMarkup.set(key, markup)
  }
  return markup
}

function tokenElement(kind: InlineTokenKind, text: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = "chat-inline-token"
  span.contentEditable = "false"
  span.dataset.kind = kind
  span.setAttribute(TOKEN_ATTRIBUTE, text)
  span.innerHTML = tokenIcon(kind, text)
  span.append(document.createTextNode(inlineTokenLabel(kind, text)))
  return span
}

function render(root: HTMLElement, segments: readonly EditorSegment[], value: string): void {
  const fragment = document.createDocumentFragment()
  for (const segment of segments) {
    if (segment.kind === "text") {
      if (segment.text) fragment.append(document.createTextNode(segment.text))
    } else {
      fragment.append(tokenElement(segment.token, segment.text))
    }
  }
  // A trailing newline needs a node after it to show the empty last line.
  if (value.endsWith("\n")) {
    const tail = document.createElement("br")
    tail.setAttribute(TAIL_ATTRIBUTE, "")
    fragment.append(tail)
  }
  root.replaceChildren(fragment)
}

/** Whether the DOM already shows exactly these segments, node for node. */
function matches(root: HTMLElement, segments: readonly EditorSegment[], value: string): boolean {
  const expected = segments.filter((segment) => segment.kind === "token" || segment.text)
  const nodes = Array.from(root.childNodes)
  const tail = value.endsWith("\n")
  if (nodes.length !== expected.length + (tail ? 1 : 0)) return false
  for (const [index, segment] of expected.entries()) {
    const node = nodes[index]!
    if (segment.kind === "text") {
      if (node.nodeType !== Node.TEXT_NODE || node.nodeValue !== segment.text) return false
    } else if (!(node instanceof Element) || node.getAttribute(TOKEN_ATTRIBUTE) !== segment.text || (node as HTMLElement).dataset.kind !== segment.token) {
      return false
    }
  }
  return !tail || (nodes.at(-1) instanceof Element && (nodes.at(-1) as Element).hasAttribute(TAIL_ATTRIBUTE))
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps & { "data-testid"?: string }>(function ComposerEditor(
  { value, segments, placeholder, disabled, className, onChange, onCaret, onKeyDown, onPasteFiles, "data-testid": testId },
  ref,
) {
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const pendingCaret = useRef<number | null>(null)
  // Our own history: DOM rebuilds would confuse the browser's undo stack.
  const history = useRef<{ entries: { value: string; caret: number; at: number; typed: boolean }[]; index: number }>({
    entries: [{ value, caret: value.length, at: 0, typed: false }],
    index: 0,
  })
  const lastEmitted = useRef(value)

  useImperativeHandle(ref, () => ({
    focus: (options) => root.current?.focus(options),
    setCaret: (offset) => {
      const element = root.current
      if (!element) return
      placeCaret(element, offset)
      onCaret(offset)
    },
    get element() {
      return root.current
    },
  }))

  const record = (next: string, caret: number, typed: boolean) => {
    const state = history.current
    const current = state.entries[state.index]
    if (current?.value === next) return
    const now = Date.now()
    state.entries = state.entries.slice(0, state.index + 1)
    if (typed && current?.typed && now - current.at < TYPING_MERGE_MS) state.entries[state.index] = { value: next, caret, at: now, typed }
    else state.entries.push({ value: next, caret, at: now, typed })
    if (state.entries.length > HISTORY_LIMIT) state.entries.shift()
    state.index = state.entries.length - 1
  }

  const emit = (next: string, caret: number, typed: boolean) => {
    lastEmitted.current = next
    record(next, caret, typed)
    onChange(next, caret)
  }

  // Replace the selection with plain text, then let the value drive the DOM.
  const insertText = (text: string) => {
    const element = root.current
    if (!element) return
    const range = selectionOffsets(element) ?? { start: value.length, end: value.length }
    const next = value.slice(0, range.start) + text + value.slice(range.end)
    pendingCaret.current = range.start + text.length
    emit(next, range.start + text.length, false)
  }

  // Backspace/Delete beside a token removes the whole token; browsers do not
  // reliably delete a non-editable inline element on their own.
  const deleteToken = (direction: "backward" | "forward"): boolean => {
    const element = root.current
    if (!element) return false
    const range = selectionOffsets(element)
    if (!range || range.start !== range.end) return false
    let offset = 0
    for (const segment of segments) {
      const start = offset
      offset += segment.text.length
      if (segment.kind !== "token") continue
      if ((direction === "backward" && offset === range.start) || (direction === "forward" && start === range.start)) {
        pendingCaret.current = start
        emit(value.slice(0, start) + value.slice(offset), start, false)
        return true
      }
    }
    return false
  }

  const restore = (step: -1 | 1) => {
    const state = history.current
    const target = state.entries[state.index + step]
    if (!target) return
    state.index += step
    pendingCaret.current = target.caret
    lastEmitted.current = target.value
    onChange(target.value, target.caret)
  }

  useLayoutEffect(() => {
    const element = root.current
    if (!element || composing.current) return
    // A value set from outside (a pick, a send, a restored draft) joins history.
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      record(value, pendingCaret.current ?? value.length, false)
    }
    if (!matches(element, segments, value)) {
      const focused = document.activeElement === element
      const caret = pendingCaret.current ?? (focused ? selectionOffsets(element)?.start : null) ?? null
      render(element, segments, value)
      if (focused && caret !== null) placeCaret(element, Math.min(caret, value.length))
    } else if (pendingCaret.current !== null && document.activeElement === element) {
      placeCaret(element, Math.min(pendingCaret.current, value.length))
    }
    pendingCaret.current = null
  })

  const readInput = () => {
    const element = root.current
    if (!element || composing.current) return
    const next = composerEditorValue(element)
    const caret = selectionOffsets(element)?.start ?? next.length
    if (next !== value) emit(next, caret, true)
    else onCaret(caret)
  }

  const reportCaret = () => {
    const element = root.current
    if (!element) return
    const offsets = selectionOffsets(element)
    if (offsets) onCaret(offsets.start)
  }

  const copySelection = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const element = root.current
    const selection = window.getSelection()
    if (!element || !selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const into = { text: "" }
    serializeNodes(selection.getRangeAt(0).cloneContents().childNodes, into)
    event.preventDefault()
    event.clipboardData.setData("text/plain", into.text)
    if (cut && !disabled) insertText("")
  }

  return (
    <div
      ref={root}
      data-testid={testId}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      aria-placeholder={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      data-empty={value === "" || undefined}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck
      autoCorrect="off"
      autoCapitalize="off"
      className={cn("composer-editor", className)}
      onInput={readInput}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
        readInput()
      }}
      onSelect={reportCaret}
      onKeyUp={reportCaret}
      onClick={reportCaret}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        const mod = event.metaKey || event.ctrlKey
        if (mod && !event.altKey && event.key.toLowerCase() === "z") {
          event.preventDefault()
          restore(event.shiftKey ? 1 : -1)
        } else if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "y") {
          event.preventDefault()
          restore(1)
        } else if ((event.key === "Backspace" || event.key === "Delete") && !event.altKey && !mod) {
          if (deleteToken(event.key === "Backspace" ? "backward" : "forward")) event.preventDefault()
        } else if (event.key === "Enter") {
          // Enter without Shift is the parent's (send or pick); Shift+Enter is a newline.
          event.preventDefault()
          if (event.shiftKey) insertText("\n")
        }
      }}
      onBeforeInput={(event) => {
        const type = (event.nativeEvent as InputEvent).inputType
        if (type === "historyUndo" || type === "historyRedo") {
          event.preventDefault()
          restore(type === "historyUndo" ? -1 : 1)
        } else if (type === "insertParagraph" || type === "insertLineBreak") {
          event.preventDefault()
          insertText("\n")
        }
      }}
      onPaste={(event) => {
        if (onPasteFiles?.(event)) return
        event.preventDefault()
        const text = event.clipboardData.getData("text/plain")
        if (text) insertText(text.replace(/\r\n?/g, "\n"))
      }}
      onCopy={(event) => copySelection(event, false)}
      onCut={(event) => copySelection(event, true)}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        // Files bubble to the composer; dropped text arrives as plain text.
        if (event.dataTransfer.files.length > 0) return
        event.preventDefault()
        const text = event.dataTransfer.getData("text/plain")
        if (!text) return
        const element = root.current
        const at = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY)
        if (element && at && element.contains(at.startContainer)) {
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(at)
        }
        insertText(text)
      }}
    />
  )
})
