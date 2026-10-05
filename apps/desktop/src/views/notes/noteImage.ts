// An image inside a note: `![alt](kybern://asset/<id>)` in the Markdown (or any web
// image link), one atom in the editor that sits on its own line. Pasted, dropped and
// picked image files are first kept by the daemon that keeps the note, so the
// Markdown only ever holds a link. Images pasted inline as `data:` URLs (copied from
// a web page or a document) are kept the same way; the Markdown never holds their
// bytes, even when an upload has not finished. This file has no React and no DOM, so the Markdown round trip is testable in Node.
import { mergeAttributes, Node, type Editor, type MarkdownTokenizer, type NodeViewRenderer } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform"

export const NOTE_IMAGE = "image"
export const ASSET_LINK_PREFIX = "kybern://asset/"

const ASSET_LINK = /^kybern:\/\/asset\/([0-9a-fA-F-]{36})\/?$/

/** The asset id in a `kybern://asset/<id>` link, or null for any other source. */
export function assetLinkId(src: string | null | undefined): string | null {
  return (src && ASSET_LINK.exec(src)?.[1]?.toLowerCase()) || null
}

/** `![alt](src "title")`, with the characters that would end each part escaped. */
export function imageMarkdown(src: string, alt = "", title?: string | null): string {
  const label = alt.replace(/[\\[\]]/g, (character) => `\\${character}`).replace(/\s*\n\s*/g, " ")
  const target = /[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src
  const suffix = title ? ` "${title.replace(/["\\]/g, (character) => `\\${character}`)}"` : ""
  return `![${label}](${target}${suffix})`
}

// Images get a token of their own: Tiptap's paragraph lifts a line holding only a
// Markdown `image` token out into a block, which an inline node cannot be. Alt text
// may escape brackets; the target may be <bracketed> or hold one level of parentheses.
const TOKEN_TYPE = "noteImage"
const TOKEN = /^!\[((?:\\.|[^\\\]\n])*)\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+"((?:\\.|[^"\\\n])*)")?\s*\)/
const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1")

const tokenizer: MarkdownTokenizer = {
  name: TOKEN_TYPE,
  level: "inline",
  start: (src) => src.indexOf("!["),
  tokenize: (src) => {
    const match = TOKEN.exec(src)
    if (!match) return undefined
    const target = match[2]!
    return {
      type: TOKEN_TYPE,
      raw: match[0],
      alt: unescape(match[1]!),
      src: target.startsWith("<") ? target.slice(1, -1) : target,
      title: match[3] === undefined ? null : unescape(match[3]),
    }
  },
}

// Every editor's Markdown manager uses the same `marked` instance, and each one
// registers its extensions' tokenizers on it again (see taskRef.ts).
function markedHasTokenizer(): boolean {
  const manager = new MarkdownManager({ extensions: [] }) as unknown as {
    markedInstance?: { defaults?: { extensions?: { startInline?: unknown[] } | null } }
  }
  return !!manager.markedInstance?.defaults?.extensions?.startInline?.includes(tokenizer.start)
}

/** Where pasted images go and come from: the daemon that keeps the note. */
export interface NoteImageHost {
  /** Keeps the file and resolves to its asset id. */
  upload(file: File): Promise<string>
  load(id: string, signal: AbortSignal): Promise<Blob>
}

export interface NoteImageOptions {
  /** The live view (React, in the editor chunk). Without it the image renders as a plain `<img>`. */
  nodeView: NodeViewRenderer | null
  /** Read when an image is added or shown; null where images cannot be added (task descriptions). */
  host: () => NoteImageHost | null
  onError: (error: unknown) => void
}

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*?)(;base64)?,(.*)$/is
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" }

/** Whether `src` is an image carried inline, as a `data:` URL. */
export function isDataImage(src: string | null | undefined): boolean {
  return !!src && /^data:image\//i.test(src)
}

/** The file inside an inline `data:image/…` URL, or null when it is not one or does not decode. */
export function dataUrlToFile(src: string): File | null {
  const match = DATA_IMAGE.exec(src.trim())
  if (!match) return null
  const type = match[1]!.toLowerCase()
  let bytes: Uint8Array<ArrayBuffer>
  try {
    if (match[3]) {
      const binary = atob(match[4]!.replace(/\s+/g, ""))
      bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[4]!))
    }
  } catch {
    return null
  }
  if (bytes.length === 0) return null
  const extension = EXTENSIONS[type] ?? type.slice("image/".length).replace(/\+.*$/, "")
  return new File([bytes], `pasted-image.${extension}`, { type })
}

/** Inline images each editor is having kept by the daemon, so one paste uploads once per editor. */
const uploading = new WeakMap<Editor, Set<string>>()

function uploadsOf(editor: Editor): Set<string> {
  let set = uploading.get(editor)
  if (!set) uploading.set(editor, (set = new Set()))
  return set
}

/** Inline images in `editor`'s document: the Markdown leaves these out until they are kept as assets. */
export function inlineImageSources(editor: Editor): Set<string> {
  const found = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === NOTE_IMAGE && typeof node.attrs.src === "string" && node.attrs.src.startsWith("data:")) found.add(node.attrs.src)
  })
  return found
}

/** The Markdown for an image node; an inline `data:` image is never written (see keepInlineImages). */
export function renderImageMarkdown(attrs: { src?: string | null; alt?: string | null; title?: string | null } | null | undefined): string {
  if (!attrs?.src || attrs.src.startsWith("data:")) return ""
  return imageMarkdown(attrs.src, attrs.alt ?? "", attrs.title)
}

const imageFiles = (files: Iterable<File | null>): File[] => [...files].filter((file): file is File => !!file && file.type.startsWith("image/"))

function optionsOf(editor: Editor): NoteImageOptions | null {
  // The configured extensions, which exist before the editor has initialized (its manager does not).
  return (editor.options.extensions.find((extension) => extension.name === NOTE_IMAGE)?.options as NoteImageOptions | undefined) ?? null
}

/** Whether this editor can take new images. */
export function canAddImages(editor: Editor): boolean {
  return !!optionsOf(editor)?.host()
}

/**
 * Keep each image file with the note's daemon, then put it on its own line at `pos`
 * (the caret when omitted). Resolves once every file is in or has failed.
 */
export async function insertImageFiles(editor: Editor, files: File[], pos?: number): Promise<void> {
  const options = optionsOf(editor)
  const host = options?.host()
  if (!options || !host) return
  let at = pos
  for (const file of imageFiles(files)) {
    let id: string
    try {
      id = await host.upload(file)
    } catch (error) {
      options.onError(error)
      continue
    }
    if (editor.isDestroyed) return
    const block = { type: "paragraph", content: [{ type: NOTE_IMAGE, attrs: { src: `${ASSET_LINK_PREFIX}${id}`, alt: "" } }] }
    const chain = editor.chain().focus()
    if (at === undefined) chain.insertContent(block)
    else chain.insertContentAt(Math.min(at, editor.state.doc.content.size), block)
    chain.run()
    // The next file follows this one.
    at = undefined
  }
}

/** Every image node whose source is `src`, last first, so changing one keeps the others' positions. */
function positionsOf(editor: Editor, src: string): number[] {
  const found: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === NOTE_IMAGE && node.attrs.src === src) found.push(pos)
  })
  return found.reverse()
}

/** Turn inline images into kept ones: upload each, then point its nodes at the asset (or drop them). */
function keepInlineImages(editor: Editor, options: NoteImageOptions, sources: Iterable<string>) {
  if (editor.isDestroyed) return
  const pending = uploadsOf(editor)
  for (const src of sources) {
    if (pending.has(src)) continue
    const host = options.host()
    const file = dataUrlToFile(src)
    const replace = (id: string | null) => {
      if (editor.isDestroyed) return
      const positions = positionsOf(editor, src)
      if (positions.length === 0) return
      const tr = editor.state.tr
      for (const pos of positions) {
        const node = tr.doc.nodeAt(pos)
        if (!node) continue
        if (id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: `${ASSET_LINK_PREFIX}${id}` })
        else tr.delete(pos, pos + node.nodeSize)
      }
      // The paste is the step to undo; this only finishes it.
      editor.view.dispatch(tr.setMeta("addToHistory", false))
    }
    if (!host || !file) {
      replace(null)
      continue
    }
    pending.add(src)
    host.upload(file).then(
      (id) => {
        pending.delete(src)
        // A closed editor already saved without the image (onDestroy said so); the host
        // has no safe way to patch a body it no longer edits.
        replace(id)
      },
      (error) => {
        pending.delete(src)
        if (!editor.isDestroyed) options.onError(error)
        replace(null)
      },
    )
  }
}

/** Ask for image files (the "/" menu's Image), then add them at the caret. Needs a document; call it from an event. */
export function chooseImageFiles(editor: Editor) {
  if (!canAddImages(editor)) return
  const picker = document.createElement("input")
  picker.type = "file"
  picker.accept = "image/*"
  picker.multiple = true
  picker.hidden = true
  const done = () => picker.remove()
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])]
    done()
    void insertImageFiles(editor, files)
  })
  picker.addEventListener("cancel", done)
  document.body.append(picker)
  picker.click()
}

const NoteImageNode = Node.create<NoteImageOptions>({
  name: NOTE_IMAGE,
  // Inline, because Markdown images are inline; a pasted one gets a paragraph of its own.
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { nodeView: null, host: () => null, onError: () => {} }
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
    }
  },

  parseHTML() {
    const options = this.options
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          const src = (element as HTMLElement).getAttribute("src")
          // A pasted local preview means nothing once the page is gone.
          if (!src || src.startsWith("blob:")) return false
          // Inline bytes stay only where they can be kept as an asset (see keepInlineImages).
          if (src.startsWith("data:") && (!isDataImage(src) || !options.host())) return false
          return { src, alt: (element as HTMLElement).getAttribute("alt") ?? "", title: (element as HTMLElement).getAttribute("title") }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)]
  },

  renderText({ node }) {
    return node.attrs.alt || ""
  },

  markdownTokenName: TOKEN_TYPE,

  parseMarkdown: (token, helpers) => helpers.createNode(NOTE_IMAGE, { src: token.src || null, alt: token.alt ?? "", title: token.title || null }),

  renderMarkdown: (node) => renderImageMarkdown(node.attrs),

  addNodeView() {
    return this.options.nodeView
  },

  // Inline images already in the text when it opens are kept as assets too, since the
  // Markdown cannot hold them.
  onCreate() {
    const sources = inlineImageSources(this.editor)
    if (sources.size > 0 && this.options.host()) keepInlineImages(this.editor, this.options, sources)
  },

  // The last save left out images still uploading; say so rather than lose them quietly.
  onDestroy() {
    if (inlineImageSources(this.editor).size > 0) {
      this.options.onError(new Error("An image didn't finish uploading before the note closed, so it wasn't saved. Paste it again."))
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey("noteImagePaste"),
        // Inline images that arrive by paste, drop or typing are kept as assets. A newer
        // version loaded from the daemon (preventUpdate) is shown as it is.
        appendTransaction: (transactions) => {
          const sources = new Set<string>()
          for (const tr of transactions) {
            if (!tr.docChanged || tr.getMeta("preventUpdate")) continue
            for (const step of tr.steps) {
              if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) continue
              step.slice.content.descendants((node) => {
                const src = node.attrs.src
                if (node.type.name === NOTE_IMAGE && typeof src === "string" && src.startsWith("data:")) sources.add(src)
              })
            }
          }
          // After this transaction is applied, so the nodes can be found.
          if (sources.size > 0) queueMicrotask(() => keepInlineImages(editor, options, sources))
          return null
        },
        props: {
          handlePaste: (_view, event) => {
            const files = imageFiles([...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()))
            if (files.length === 0 || !options.host()) return false
            event.preventDefault()
            void insertImageFiles(editor, files)
            return true
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved) return false
            const files = imageFiles(event.dataTransfer?.files ?? [])
            if (files.length === 0 || !options.host()) return false
            event.preventDefault()
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            void insertImageFiles(editor, files, pos)
            return true
          },
        },
      }),
    ]
  },
})

/** The image node, carrying its Markdown tokenizer until `marked` has it. */
export function createNoteImage(options: Partial<NoteImageOptions> = {}) {
  const configured = NoteImageNode.configure(options)
  return markedHasTokenizer() ? configured : configured.extend({ markdownTokenizer: tokenizer })
}
