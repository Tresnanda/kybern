// The note editor's schema: what a note can contain, and the "/" trigger.
// Everything stores as Markdown (@tiptap/markdown), so a note stays a plain
// text file anywhere else it goes: Copy as Markdown, Export, the CLI.
import { Extension, InputRule, type AnyExtension, type NodeViewRenderer } from "@tiptap/core"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion"

import { filterSlashItems, type SlashItem } from "./slashItems"
import { createTaskLinks, type TaskLineHost } from "./taskLinks"
import { createTaskRef } from "./taskRef"

/** `[ ] ` or `[x] ` typed at the start of a bullet turns that bullet into a checklist item. */
const BulletToChecklist = Extension.create({
  name: "bulletToChecklist",
  addInputRules() {
    return [
      new InputRule({
        find: /^\[([ xX])?\]\s$/,
        handler: ({ state, range, chain }) => {
          const { $from } = state.selection
          const inBullet = $from.depth >= 2 && $from.node($from.depth - 2).type.name === "bulletList"
          if (!inBullet) return null
          chain().deleteRange(range).toggleTaskList().run()
          return undefined
        },
      }),
    ]
  },
})

export interface SlashOptions {
  suggestion: Omit<SuggestionOptions<SlashItem, SlashItem>, "editor">
}

const defaultSuggestion: SlashOptions["suggestion"] = {
  char: "/",
  items: ({ query }) => filterSlashItems(query),
  command: ({ editor, range, props }) => props.run(editor, range),
  // Code is literal: a slash there is just a slash.
  allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
}

const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",
  addOptions() {
    return { suggestion: defaultSuggestion }
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })]
  },
})

export function createNoteExtensions(
  slash: SlashOptions["suggestion"]["render"],
  placeholder: string,
  tasks: { view: NodeViewRenderer; lines: TaskLineHost },
): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        // In-app links (`kybern://thread/<id>`, written by "Save to note") are intercepted by the editor.
        protocols: ["kybern"],
        HTMLAttributes: { rel: "noopener noreferrer", target: null },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    BulletToChecklist,
    // `[ADE-14](kybern://task/<id>)`: a live task reference, linked from typed and pasted keys.
    createTaskRef(tasks.view),
    createTaskLinks(tasks.lines),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level}` : placeholder),
      showOnlyCurrent: true,
    }),
    Markdown,
    SlashCommand.configure({ suggestion: { ...defaultSuggestion, render: slash } }),
  ]
}
