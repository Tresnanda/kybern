// A gallery card's miniature: the note's first blocks drawn small from its Markdown
// (state/miniMarkdown.ts), not a live editor. Sizes are ems of one scale variable, so
// the text is rasterized at its real small size and stays crisp. Short notes are
// laid out larger and centered, so a three-line checklist still fills its card.
import { memo } from "react"

import type { NoteSummary } from "@/protocol"
import type { MiniBlock, MiniDoc, MiniSpan } from "@/state/miniMarkdown"
import { useNoteThumb } from "@/state/noteThumbs"
import { useTask } from "@/state/tasks"
import { TaskStatusGlyph } from "../tasks/TaskGlyphs"

/** At or under this many lines a thumbnail is laid out larger and centered. */
const SHORT_LINES = 4

/** A task reference drawn small: its status glyph and key, live. */
function MiniTaskRef({ id, label }: { id: string; label: string }) {
  const task = useTask(id)
  return (
    <span className="mini-task-ref" data-missing={task ? undefined : ""}>
      {task ? <TaskStatusGlyph status={task.status} size={10} /> : <i className="mini-task-ref-empty" />}
      <span>{task?.key ?? label}</span>
    </span>
  )
}

function Spans({ spans }: { spans: MiniSpan[] }) {
  return (
    <>
      {spans.map((span, index) =>
        span.task ? (
          <MiniTaskRef key={index} id={span.task} label={span.text} />
        ) : span.code ? (
          <code key={index}>{span.text}</code>
        ) : span.strong ? (
          <strong key={index}>{span.text}</strong>
        ) : (
          <span key={index}>{span.text}</span>
        ),
      )}
    </>
  )
}

const Tick = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function Block({ block }: { block: MiniBlock }) {
  switch (block.kind) {
    case "heading":
      return (
        <p className="mini-h" data-level={block.level}>
          <Spans spans={block.spans} />
        </p>
      )
    case "paragraph":
      return (
        <p className="mini-p">
          <Spans spans={block.spans} />
        </p>
      )
    case "quote":
      return (
        <p className="mini-quote">
          <Spans spans={block.spans} />
        </p>
      )
    case "checklist":
      return (
        <div className="mini-checklist">
          {block.items.map((item, index) => (
            <p key={index} className="mini-task" data-done={item.done || undefined}>
              <span className="mini-box">{item.done && <Tick />}</span>
              <span className="mini-task-text">
                <Spans spans={item.spans} />
              </span>
            </p>
          ))}
        </div>
      )
    case "list":
      return (
        <div className="mini-list">
          {block.items.map((spans, index) => (
            <p key={index} className="mini-li">
              <span className="mini-marker">{block.ordered ? `${index + 1}.` : "•"}</span>
              <span className="mini-task-text">
                <Spans spans={spans} />
              </span>
            </p>
          ))}
        </div>
      )
    case "code":
      return (
        <div className="mini-code">
          {block.lines.map((line, index) => (
            <div key={index}>{line || " "}</div>
          ))}
        </div>
      )
    case "rule":
      return <hr className="mini-rule" />
  }
}

function MiniContent({ doc }: { doc: MiniDoc }) {
  return (
    <>
      {doc.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

/** The preview text, while the note's own blocks are read. */
function previewDoc(note: NoteSummary): MiniDoc {
  const text = note.preview.trim()
  return { blocks: text ? [{ kind: "paragraph", spans: [{ text }] }] : [], lines: Math.ceil(text.length / 64) }
}

export const NoteThumb = memo(function NoteThumb({ note }: { note: NoteSummary }) {
  const loaded = useNoteThumb(note)
  const doc = loaded ?? previewDoc(note)
  const empty = doc.blocks.length === 0
  return (
    <div className="note-thumb" aria-hidden="true" data-short={!empty && doc.lines <= SHORT_LINES ? "" : undefined} data-empty={empty ? "" : undefined}>
      {empty ? <p className="mini-empty">No text yet</p> : <div className="mini"><MiniContent doc={doc} /></div>}
    </div>
  )
})
