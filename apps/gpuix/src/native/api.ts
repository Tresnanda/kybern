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
