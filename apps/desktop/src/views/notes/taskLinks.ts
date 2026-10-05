// Tasks inside the note editor (the editor chunk):
// - a task key typed before a space or punctuation, or pasted, becomes a live
//   reference when it names a task; ⌘Z right after puts the plain key back;
// - an unlinked checklist line offers "Make task" while the pointer is over it,
//   and ⌘⇧T does the same for the line with the caret.
// What a task is made from, and the linking itself, live in noteTaskActions.ts and
// the daemon; this file only finds the line and draws the affordance.
import { Task01Icon } from "@hugeicons/core-free-icons"
import { combineTransactionSteps, Extension, getChangedRanges, InputRule, type Editor } from "@tiptap/core"
import type { Node as PMNode, Schema } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { ReplaceStep } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

import { findTask } from "@/state/tasks"
import { standaloneTaskKeys, typedTaskKey } from "@/state/tasksModel"
import { TASK_REF } from "./taskRef"

export const TASK_ITEM = "taskItem"

/** The first task reference in a line, if it has one. */
export function lineTaskRef(paragraph: PMNode): PMNode | null {
  let found: PMNode | null = null
  paragraph.descendants((node) => {
    if (found) return false
    if (node.type.name === TASK_REF) found = node
    return !found
  })
  return found
}

/** The checklist item around a position: its position and node. */
export function taskItemAt(state: EditorState, pos: number): { pos: number; node: PMNode } | null {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size))
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (node.type.name === TASK_ITEM) return { pos: $pos.before(depth), node }
  }
  return null
}

/** A line can become a task when it has words, is not done and links no task yet. */
export function canMakeTaskFrom(item: PMNode): boolean {
  const line = item.firstChild
  return !!line?.isTextblock && !item.attrs.checked && !!line.textContent.trim() && !lineTaskRef(line)
}

const hasRef = (node: PMNode) => {
  let found = false
  node.descendants((child) => {
    if (child.type.name === TASK_REF) found = true
    return !found
  })
  return found
}

/** True when the last input rule to run made a task reference, so ⌘Z should only undo that. */
function lastRuleLinkedTask(state: EditorState): boolean {
  for (const plugin of state.plugins) {
    const spec = plugin.spec as { isInputRules?: boolean }
    if (!spec.isInputRules) continue
    const undoable = plugin.getState(state) as { transform?: { steps: unknown[] } } | undefined
    if (!undoable?.transform) continue
    for (const step of undoable.transform.steps) {
      if (!(step instanceof ReplaceStep)) continue
      let found = false
      step.slice.content.forEach((node) => {
        if (node.type.name === TASK_REF || hasRef(node)) found = true
      })
      if (found) return true
    }
  }
  return false
}

/** Text where a key may not be linked: code, or text already inside a link. */
function linkableText(node: PMNode, parent: PMNode | null): boolean {
  if (parent?.type.spec.code) return false
  return !node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link")
}

const MARKDOWN_TASK_LINK = /\[([^\]\n]{1,64})\]\(kybern:\/\/task\/([0-9a-fA-F-]{36})\/?\)/g

/** Task references for keys and `[KEY](kybern://task/…)` links in pasted text. */
function linkPasted(state: EditorState, ranges: { from: number; to: number }[], schema: Schema) {
  const type = schema.nodes[TASK_REF]
  if (!type) return null
  const edits: { from: number; to: number; node: PMNode }[] = []
  for (const range of ranges) {
    state.doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
      if (!node.isText || !node.text || !linkableText(node, parent)) return
      const text = node.text
      const taken: [number, number][] = []
      for (const match of text.matchAll(MARKDOWN_TASK_LINK)) {
        const start = match.index ?? 0
        taken.push([start, start + match[0].length])
        edits.push({ from: pos + start, to: pos + start + match[0].length, node: type.create({ id: match[2]!.toLowerCase(), label: match[1]! }) })
      }
      for (const { key, index } of standaloneTaskKeys(text)) {
        if (taken.some(([from, to]) => index >= from && index < to)) continue
        const task = findTask(key)
        if (task?.key === key) edits.push({ from: pos + index, to: pos + index + key.length, node: type.create({ id: task.id, label: key }) })
      }
    })
  }
  if (edits.length === 0) return null
  const tr = state.tr
  // Last first, so earlier positions stay valid.
  for (const edit of edits.sort((a, b) => b.from - a.from)) tr.replaceWith(edit.from, edit.to, edit.node)
  return tr
}

// ---- the "Make task" affordance ----

export interface TaskLineHost {
  /** False where a line cannot become a task: quick capture, a read-only note. */
  enabled(): boolean
  /** Make a task from the checklist item at `pos`. */
  makeTask(editor: Editor, pos: number): void
  /** Lines being made into tasks right now (their item positions are not tracked; their text is). */
  busy(text: string): boolean
}

const hoverKey = new PluginKey<{ pos: number | null }>("taskLineHover")

function svgIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("aria-hidden", "true")
  for (const [tag, attrs] of Task01Icon as unknown as [string, Record<string, string>][]) {
    const child = document.createElementNS(ns, tag)
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "key") continue
      child.setAttribute(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), name === "strokeWidth" ? "2" : value)
    }
    svg.appendChild(child)
  }
  return svg
}

function makeTaskWidget(view: EditorView, editor: Editor, host: TaskLineHost): HTMLElement {
  const wrap = document.createElement("span")
  wrap.className = "task-line-make"
  wrap.contentEditable = "false"
  const button = document.createElement("button")
  button.type = "button"
  button.className = "task-line-make-button"
  button.tabIndex = -1
  button.title = "Make a task from this line (⌘⇧T)"
  button.append(svgIcon(), document.createTextNode("Make task"))
  // Keep the caret where it is; act on the line under the pointer.
  button.addEventListener("mousedown", (event) => event.preventDefault())
  button.addEventListener("click", (event) => {
    event.preventDefault()
    const pos = hoverKey.getState(view.state)?.pos
    if (pos != null) host.makeTask(editor, pos)
  })
  wrap.append(button)
  return wrap
}

function hoveredItem(view: EditorView, target: EventTarget | null): number | null {
  const element = target instanceof Element ? target : null
  if (!element || element.closest(".task-line-make")) return hoverKey.getState(view.state)?.pos ?? null
  const item = element.closest('ul[data-type="taskList"] > li')
  if (!item || !view.dom.contains(item)) return null
  const content = item.querySelector(":scope > div")
  if (!content) return null
  try {
    return taskItemAt(view.state, view.posAtDOM(content, 0))?.pos ?? null
  } catch {
    return null
  }
}

export function createTaskLinks(host: TaskLineHost) {
  return Extension.create({
    name: "taskLinks",
    // Ahead of the history keymap, so ⌘Z after an autolink undoes only the link.
    priority: 1000,

    addInputRules() {
      return [
        new InputRule({
          find: (text) => {
            const hit = typedTaskKey(text)
            if (!hit) return null
            const task = findTask(hit.key)
            if (!task || task.key !== hit.key) return null
            return { index: hit.index, text: text.slice(hit.index), data: { id: task.id, key: hit.key } }
          },
          handler: ({ state, range, match }) => {
            const type = state.schema.nodes[TASK_REF]
            const data = match.data as { id: string; key: string } | undefined
            if (!type || !data) return null
            const $from = state.doc.resolve(range.from)
            const textNode = $from.nodeAfter
            if (textNode && !linkableText(textNode, $from.parent)) return null
            const typed = match[0].slice(data.key.length)
            const { tr } = state
            tr.replaceWith(range.from, range.to, type.create({ id: data.id, label: data.key }))
            tr.insertText(typed)
          },
        }),
      ]
    },

    addKeyboardShortcuts() {
      return {
        "Mod-z": () => (lastRuleLinkedTask(this.editor.state) ? this.editor.commands.undoInputRule() : false),
        "Mod-Shift-t": () => {
          if (!host.enabled() || !this.editor.isEditable) return false
          const item = taskItemAt(this.editor.state, this.editor.state.selection.from)
          if (!item) return false
          host.makeTask(this.editor, item.pos)
          return true
        },
      }
    },

    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: new PluginKey("taskLinkPaste"),
          appendTransaction: (transactions, oldState, newState) => {
            if (!transactions.some((tr) => tr.docChanged && (tr.getMeta("uiEvent") === "paste" || tr.getMeta("paste")))) return null
            const ranges = getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions])).map(({ newRange }) => newRange)
            return linkPasted(newState, ranges, newState.schema)
          },
        }),
        new Plugin<{ pos: number | null }>({
          key: hoverKey,
          state: {
            init: () => ({ pos: null }),
            apply(tr, value) {
              const meta = tr.getMeta(hoverKey) as { pos: number | null } | undefined
              if (meta) return meta
              if (value.pos === null || !tr.docChanged) return value
              const mapped = tr.mapping.mapResult(value.pos, 1)
              return { pos: mapped.deleted ? null : mapped.pos }
            },
          },
          props: {
            decorations(state) {
              const pos = hoverKey.getState(state)?.pos
              if (pos == null || !host.enabled() || !editor.isEditable) return null
              const item = state.doc.nodeAt(pos)
              if (!item || item.type.name !== TASK_ITEM || !canMakeTaskFrom(item)) return null
              const line = item.firstChild!
              if (host.busy(line.textContent)) return null
              // The end of the line's own text, before any nested list.
              const lineEnd = pos + 2 + line.content.size
              return DecorationSet.create(state.doc, [
                Decoration.node(pos, pos + item.nodeSize, { class: "task-line-hover" }),
                Decoration.widget(lineEnd, (view) => makeTaskWidget(view, editor, host), {
                  side: 1,
                  key: "make-task",
                  ignoreSelection: true,
                  stopEvent: () => true,
                }),
              ])
            },
            handleDOMEvents: {
              mousemove(view, event) {
                const pos = hoveredItem(view, event.target)
                if (pos !== (hoverKey.getState(view.state)?.pos ?? null)) view.dispatch(view.state.tr.setMeta(hoverKey, { pos }).setMeta("addToHistory", false))
                return false
              },
              mouseleave(view) {
                if (hoverKey.getState(view.state)?.pos != null) view.dispatch(view.state.tr.setMeta(hoverKey, { pos: null }).setMeta("addToHistory", false))
                return false
              },
            },
          },
        }),
      ]
    },
  })
}
