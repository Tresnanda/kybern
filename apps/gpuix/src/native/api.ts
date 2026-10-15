/** macOS capabilities in the Kybern native build. Offsets are UTF-16 units. */
export interface InputSelection {
  start: number
  end: number
  reversed: boolean
  composing: boolean
}
export interface InputEdit {
  start: number
  end: number
  text: string
  /** Reject stale edits instead of overwriting typing that arrived meanwhile. */
  expectedValue: string
}
export interface TextSelectionRange {
  elementId: number
  sub: number
  start: number
  end: number
  /** Entire run; selected text is text.slice(start, end). */
  text: string
}
export interface NativeCapabilities {
  registerFont(data: Buffer): void
  getInputSelection(elementId: number): InputSelection
  setInputSelection(elementId: number, start: number, end: number, reversed: boolean): void
  /** One native undo step; emits onChange. Rejects secure/read-only/IME input. */
  editInput(elementId: number, edit: InputEdit): void
  getTextSelection(): TextSelectionRange[]
  /** Select one currently painted prose/code run, retaining it across replay. */
  setTextSelection(elementId: number, sub: number, start: number, end: number): void
}

/** Pass useGpuixRequired(). Throws clearly for an old or stock native binary. */
export function nativeCapabilities(renderer: object): NativeCapabilities {
  for (const method of ['registerFont', 'getInputSelection', 'setInputSelection', 'editInput', 'getTextSelection', 'setTextSelection'] as const) {
    if (typeof (renderer as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`Native capability ${method} requires the current Kybern native build`)
    }
  }
  return renderer as NativeCapabilities
}

export interface InputDecoration {
  start: number
  end: number
  style?: {
    color?: string
    backgroundColor?: string
    fontWeight?: number
    fontStyle?: 'normal' | 'italic'
    underline?: boolean
    /** Visual radius in pixels; wrapped spans round only their external ends. */
    borderRadius?: number
    /** Visual-only outset, clamped to half the adjacent whitespace and input edges. */
    backgroundOutsetX?: number
    /** Only zero is currently supported. */
    paddingX?: 0
  }
  atomic?: boolean
  id?: string
}
export interface DecoratedInputCapabilities {
  /** UTF-16 ranges, guarded against stale React effects; does not add an undo step. */
  setInputDecorations(elementId: number, decorations: InputDecoration[], expectedValue: string): void
  /** Logical window content coordinates; returns the last matching identified range. */
  hitTestInputDecoration(elementId: number, x: number, y: number): string | null
}
export function decoratedInputCapabilities(renderer: object): DecoratedInputCapabilities {
  for (const method of ['setInputDecorations', 'hitTestInputDecoration'] as const) {
    if (typeof (renderer as Record<string, unknown>)[method] !== 'function') throw Error(`Native capability ${method} requires the current Kybern native build`)
  }
  return renderer as DecoratedInputCapabilities
}
/** Cached ancestors are invalidated; queued offsets apply after child splices in the next draw. */
export interface CachedListCapabilities {
  scrollToItem(elementId: number, index: number, offsetInItem?: number): void
  getListScrollTop(elementId: number): number[] | null
}
