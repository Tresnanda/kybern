// How an image reads inside a note. A `kybern://asset/<id>` link is read from the
// note's daemon (assets need the daemon token, so an `<img>` cannot fetch them on its
// own) and shown from a blob URL; any other link is shown as it is. Blob URLs are
// kept in a small cache so an edit that redraws the note does not read them again.
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useEffect, useState } from "react"

import { assetLinkId, type NoteImageOptions } from "./noteImage"

const CACHE_LIMIT = 48
const cache = new Map<string, Promise<string>>()

function loadImage(id: string, host: NoteImageOptions["host"]): Promise<string> {
  const cached = cache.get(id)
  if (cached) {
    // Most recently used last, so eviction takes the oldest.
    cache.delete(id)
    cache.set(id, cached)
    return cached
  }
  const current = host()
  if (!current) return Promise.reject(new Error("Images are unavailable here"))
  // Shared by every view of the image, so no single view's unmount cancels it.
  const pending = current.load(id, new AbortController().signal).then((blob) => URL.createObjectURL(blob))
  pending.catch(() => {
    if (cache.get(id) === pending) cache.delete(id)
  })
  cache.set(id, pending)
  while (cache.size > CACHE_LIMIT) {
    const [oldest, url] = cache.entries().next().value!
    cache.delete(oldest)
    void url.then(URL.revokeObjectURL, () => {})
  }
  return pending
}

export function NoteImageView({ node, selected, extension }: ReactNodeViewProps) {
  const src = (node.attrs.src as string | null) ?? ""
  const alt = (node.attrs.alt as string | null) ?? ""
  const id = assetLinkId(src)
  // The getter, not the options object: node view updates can bring a new options object.
  const host = (extension.options as NoteImageOptions).host
  const [state, setState] = useState<{ id: string; url: string | null; failed: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!id) return
    let live = true
    const settle = (url: string | null) => {
      if (!live) return
      setState((previous) => (previous?.id === id && previous.url === url && previous.failed === !url ? previous : { id, url, failed: !url }))
    }
    loadImage(id, host).then(settle, () => settle(null))
    return () => {
      live = false
    }
  }, [id, host, attempt])

  const current = id && state?.id === id ? state : null
  const shown = id ? current?.url : src
  return (
    <NodeViewWrapper as="span" className="note-image" data-selected={selected || undefined} data-drag-handle="">
      {shown ? (
        <img src={shown} alt={alt} title={(node.attrs.title as string | null) ?? undefined} draggable={false} />
      ) : current?.failed ? (
        <button
          type="button"
          className="note-image-pending"
          contentEditable={false}
          onClick={() => {
            setState(null)
            setAttempt((value) => value + 1)
          }}
        >
          Image unavailable. Click to try again
        </button>
      ) : (
        <span className="note-image-pending" aria-label={alt ? `Loading ${alt}` : "Loading image"} />
      )}
    </NodeViewWrapper>
  )
}
