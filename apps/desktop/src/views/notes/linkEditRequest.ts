// The link bubble's Edit, on the Notes page: it asks the page's toolbar to open its link field.
import type { Editor } from "@tiptap/core"
import { create } from "zustand"

/** The editor whose link the toolbar should open for editing. */
export const useLinkEditRequest = create<{ editor: Editor | null }>()(() => ({ editor: null }))
