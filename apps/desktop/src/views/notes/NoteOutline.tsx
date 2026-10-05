// The document outline in the left margin: the note's headings, the current section
// marked as you read. Kept open it lists the headings; otherwise it is a rail of
// short dashes that opens while the pointer or focus is on it. Headings are read
// from the editor after typing pauses; positions are measured once per change and
// the scroll handler only binary-searches them, once per frame.
import type { Editor } from "@tiptap/core"
import { useEffect, useMemo, useRef, useState } from "react"

import { useReducedMotion } from "motion/react"
import { observeResizeFrame } from "@/lib/resizeObserver"
import type { OutlineHeading } from "./outlineHeadings"

/** A heading counts as the current section once it is this close to the top of the page. */
const ACTIVE_OFFSET = 120

export function NoteOutline({
  editor,
  headings,
  scroller,
  open,
}: {
  editor: Editor
  headings: OutlineHeading[]
  scroller: HTMLElement | null
  /** Kept open; otherwise a dash rail that opens on hover. */
  open: boolean
}) {
  const [active, setActive] = useState(0)
  const tops = useRef<number[]>([])
  const reduced = useReducedMotion() ?? false

  const nodeTop = useMemo(
    () => (pos: number): number | null => {
      if (!scroller || editor.isDestroyed) return null
      const dom = editor.view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return null
      return dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    },
    [editor, scroller],
  )

  // Where each heading sits, measured when the headings or the page size change.
  useEffect(() => {
    if (!scroller) return
    let frame = 0
    const measure = () => {
      tops.current = headings.map((heading) => nodeTop(heading.pos) ?? Number.POSITIVE_INFINITY)
      update()
    }
    const update = () => {
      const line = scroller.scrollTop + ACTIVE_OFFSET
      const list = tops.current
      // The last heading above the reading line.
      let low = 0
      let high = list.length - 1
      let found = 0
      while (low <= high) {
        const mid = (low + high) >> 1
        if (list[mid]! <= line) {
          found = mid
          low = mid + 1
        } else high = mid - 1
      }
      setActive(found)
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    measure()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    const content = scroller.firstElementChild ?? scroller
    const stop = observeResizeFrame(content, measure)
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(frame)
      stop()
    }
  }, [headings, scroller, nodeTop])

  const go = (index: number) => {
    const heading = headings[index]
    const top = heading ? nodeTop(heading.pos) : null
    if (!scroller || top === null) return
    scroller.scrollTo({ top: Math.max(0, top - 96), behavior: reduced ? "auto" : "smooth" })
    setActive(index)
  }

  const minLevel = Math.min(...headings.map((heading) => heading.level))
  return (
    <nav className="note-outline" data-open={open || undefined} aria-label="Outline">
      <p className="note-outline-title">Outline</p>
      <ol>
        {headings.map((heading, index) => (
          <li key={`${heading.pos}:${heading.text}`}>
            <button
              type="button"
              className="note-outline-item"
              data-depth={Math.min(2, heading.level - minLevel)}
              data-active={index === active || undefined}
              aria-current={index === active ? "location" : undefined}
              onClick={() => go(index)}
            >
              <i className="note-outline-dash" aria-hidden="true" />
              <span className="note-outline-label">{heading.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
