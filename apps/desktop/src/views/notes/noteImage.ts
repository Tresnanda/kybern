// An image inside a note: `![alt](kybern://asset/<id>)` in the Markdown (or any web
// image link), one atom in the editor that sits on its own line. Pasted, dropped and
// picked image files are first kept by the daemon that keeps the note, so the
// Markdown only ever holds a link. This file has no React and no DOM, so the
// Markdown round trip is testable in Node.
import { mergeAttributes, Node, type Editor, type MarkdownTokenizer, type NodeViewRenderer } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"
import { Plugin, PluginKey } from "@tiptap/pm/state"

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
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => {
          const src = (element as HTMLElement).getAttribute("src")
          // A pasted local preview means nothing once the page is gone.
          if (!src || src.startsWith("blob:")) return false
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

  renderMarkdown: (node) => (node.attrs?.src ? imageMarkdown(node.attrs.src, node.attrs.alt ?? "", node.attrs.title) : ""),

  addNodeView() {
    return this.options.nodeView
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey("noteImagePaste"),
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
