// A group keeps its chat mounted under a document tab (opacity 0, no pointer events), so switching back is instant and
// keeps the reading position. Native web documents in that chat (inline visuals) read this to stay hidden meanwhile.
import { createContext, useContext } from 'react'

export const ChatHidden = createContext(false)
export const useChatHidden = () => useContext(ChatHidden)
