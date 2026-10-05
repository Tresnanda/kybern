// Drives the "/" menu: Tiptap's suggestion plugin writes here, the menu reads.
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion"

import type { SlashItem } from "./slashItems"

export interface SlashState {
  open: boolean
  items: SlashItem[]
  /** What was typed after the "/". */
  query: string
  index: number
  rect: (() => DOMRect | null) | null
  choose: ((item: SlashItem) => void) | null
}

const CLOSED: SlashState = { open: false, items: [], query: "", index: 0, rect: null, choose: null }

export interface SlashController {
  subscribe: (listener: () => void) => () => void
  getState: () => SlashState
  setIndex: (index: number) => void
  render: NonNullable<SuggestionOptions<SlashItem, SlashItem>["render"]>
}

export function createSlashController(): SlashController {
  let state = CLOSED
  const listeners = new Set<() => void>()
  const set = (next: SlashState) => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const fromProps = (props: SuggestionProps<SlashItem, SlashItem>, index: number): SlashState => ({
    open: true,
    items: props.items,
    query: props.query,
    index: Math.min(index, Math.max(0, props.items.length - 1)),
    rect: props.clientRect ?? null,
    choose: props.command,
  })
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState: () => state,
    setIndex(index) {
      if (state.open && index !== state.index) set({ ...state, index })
    },
    render: () => ({
      onStart: (props) => set(fromProps(props, 0)),
      // Typing narrows the list, so the highlight returns to the best match.
      onUpdate: (props) => set(fromProps(props, 0)),
      onExit: () => set(CLOSED),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        // Esc closes the menu and nothing else: a dialog around the editor stays open.
        if (event.key === "Escape" && state.open) event.stopPropagation()
        if (!state.open || state.items.length === 0) return false
        const count = state.items.length
        switch (event.key) {
          case "ArrowDown":
            set({ ...state, index: (state.index + 1) % count })
            return true
          case "ArrowUp":
            set({ ...state, index: (state.index - 1 + count) % count })
            return true
          case "Enter":
          case "Tab": {
            const item = state.items[state.index]
            if (item) state.choose?.(item)
            return true
          }
          default:
            return false
        }
      },
    }),
  }
}
