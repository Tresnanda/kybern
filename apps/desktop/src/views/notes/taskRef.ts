// A task reference inside a note: `[ADE-14](kybern://task/<id>)` in the Markdown,
// one inline atom in the editor. The atom keeps the label it was written with, so
// the Markdown round-trips exactly; what it shows (key, status) is read live from
// the tasks store by its node view. This file has no React and no DOM, so the
// Markdown round trip is testable in Node.
import { mergeAttributes, Node, type MarkdownTokenizer, type NodeViewRenderer } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"

import { TASK_LINK_PREFIX, taskLinkId, taskLinkMarkdown } from "../../state/tasksModel.ts"

export const TASK_REF = "taskRef"

const TOKEN = /^\[([^\]\n]{1,64})\]\(kybern:\/\/task\/([0-9a-fA-F-]{36})\/?\)/
const TOKEN_START = /\[[^\]\n]{1,64}\]\(kybern:\/\/task\//

const tokenizer: MarkdownTokenizer = {
  name: TASK_REF,
  level: "inline",
  start: (src) => src.search(TOKEN_START),
  tokenize: (src) => {
    const match = TOKEN.exec(src)
    if (!match) return undefined
    return { type: TASK_REF, raw: match[0], label: match[1]!, id: match[2]!.toLowerCase() }
  },
}

// Every editor's Markdown manager uses the same `marked` instance (the module's
// default), and each one registers its extensions' tokenizers on it again. This
// tokenizer is added only while that instance does not have it yet.
function markedHasTokenizer(): boolean {
  const manager = new MarkdownManager({ extensions: [] }) as unknown as {
    markedInstance?: { defaults?: { extensions?: { startInline?: unknown[] } | null } }
  }
  return !!manager.markedInstance?.defaults?.extensions?.startInline?.includes(tokenizer.start)
}

export interface TaskRefOptions {
  /** The live view (React, in the editor chunk). Without it the atom renders as a plain link. */
  nodeView: NodeViewRenderer | null
}

const TaskRefNode = Node.create<TaskRefOptions>({
  name: TASK_REF,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  // Ahead of the link mark, so a pasted `<a href="kybern://task/…">` stays a reference.
  priority: 1001,

  addOptions() {
    return { nodeView: null }
  },

  addAttributes() {
    return {
      id: { default: null },
      /** The text the link was written with, usually the key at the time. */
      label: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: `a[href^="${TASK_LINK_PREFIX}"]`,
        priority: 1001,
        getAttrs: (element) => {
          const id = taskLinkId((element as HTMLElement).getAttribute("href"))
          return id ? { id, label: (element as HTMLElement).textContent?.trim() || "Task" } : false
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["a", mergeAttributes({ href: `${TASK_LINK_PREFIX}${node.attrs.id}`, "data-task-ref": "" }, { class: HTMLAttributes.class }), node.attrs.label]
  },

  renderText({ node }) {
    return node.attrs.label
  },

  parseMarkdown: (token, helpers) => helpers.createNode(TASK_REF, { id: token.id, label: token.label }),

  renderMarkdown: (node) => taskLinkMarkdown(node.attrs?.label || "Task", node.attrs?.id ?? ""),

  addNodeView() {
    return this.options.nodeView
  },
})

/** The task reference node, carrying its Markdown tokenizer until `marked` has it. */
export function createTaskRef(nodeView: NodeViewRenderer | null = null) {
  const configured = TaskRefNode.configure({ nodeView })
  return markedHasTokenizer() ? configured : configured.extend({ markdownTokenizer: tokenizer })
}
