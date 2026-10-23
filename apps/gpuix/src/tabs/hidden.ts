// A group keeps its chat mounted under a document tab (opacity 0, no pointer events), so switching back is instant and
// keeps the reading position. Native web documents in that chat (inline visuals) read this to stay hidden meanwhile.
import { createContext, useContext, type MutableRefObject } from 'react'

export const ChatHidden = createContext(false)
export const useChatHidden = () => useContext(ChatHidden)

/** A key a document tab's body may handle while the tab has focus. */
export type DocumentKey = { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } }
/** The key handler a document body registers (the image tab's ⌘+ ⌘− ⌘0, a file's ⌘S); the host calls it for keys while the tab has focus. */
export const DocumentKeys = createContext<MutableRefObject<((event: DocumentKey) => boolean) | null> | null>(null)
