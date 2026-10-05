// The headings of an open note, for its outline: read from the editor a moment after typing pauses.
import type { Editor } from "@tiptap/core"
import { useEffect, useState } from "react"

export interface OutlineHeading {
  pos: number
  level: number
  text: string
}

/** More headings than this are left out; the outline is for finding your way, not an index. */
const MAX_HEADINGS = 80
const READ_DELAY_MS = 250

function readHeadings(editor: Editor): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name !== "heading" || headings.length >= MAX_HEADINGS) return
    const text = node.textContent.trim()
    if (text) headings.push({ pos: offset, level: Number(node.attrs.level) || 1, text })
  })
  return headings
}

/** The document's headings, read again a moment after each edit. */
export function useHeadings(editor: Editor | null): OutlineHeading[] {
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  useEffect(() => {
    if (!editor) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      const next = readHeadings(editor)
      setHeadings((previous) =>
        previous.length === next.length && previous.every((heading, index) => heading.pos === next[index]!.pos && heading.text === next[index]!.text && heading.level === next[index]!.level)
          ? previous
          : next,
      )
    }
    read()
    const onUpdate = () => {
      clearTimeout(timer)
      timer = setTimeout(read, READ_DELAY_MS)
    }
    editor.on("update", onUpdate)
    return () => {
      clearTimeout(timer)
      editor.off("update", onUpdate)
    }
  }, [editor])
  return headings
}
