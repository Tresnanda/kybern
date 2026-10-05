// The floating bar over selected text: turn into, bold, italic, strike, code, link.
// A second small bubble shows when the caret sits inside a link: Open, Edit, Remove.
// The Notes page has its own toolbar (NoteToolbar), so there only the link bubble
// shows, and its Edit opens the toolbar's link field instead.
import type { Editor } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { ArrowLeftIcon, BoldIcon, CheckIcon, ChevronDownIcon, CodeIcon, ItalicIcon, LinkIcon, StrikethroughIcon, type LucideIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { useLinkEditRequest } from "./linkEditRequest"
import { normalizeLinkTarget } from "./linkTarget"
import { openNoteLink } from "./noteLinks"
import { SLASH_ICONS } from "./slashIcons"
import { currentBlockId, TURN_INTO_ITEMS, turnInto } from "./slashItems"

export function FormatButton({
  icon: Icon,
  label,
  shortcut,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  shortcut?: string[]
  active?: boolean
  onClick: () => void
}) {
  // Shortcuts read as plain text beside the name ("Bold ⌘B"), not as key caps.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            // Keep the text selected: a click here must not move focus out of the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
            className={cn(
              "press inline-flex size-7 cursor-pointer items-center justify-center rounded-md outline-hidden transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "bg-[var(--color-background-button-secondary)] text-foreground"
                : "text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
            )}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" sideOffset={8}>
        <span className="flex items-center gap-1.5">
          {label}
          {shortcut && <span className="notes-tip-key">{shortcut.join("")}</span>}
        </span>
      </TooltipPopup>
    </Tooltip>
  )
}

export function LinkField({ editor, initial, onDone }: { editor: Editor; initial: string; onDone: () => void }) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  // The bar can still be hidden for a moment (it appears a beat after the selection), so keep trying until the field takes focus.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const focus = () => {
      const field = input.current
      if (!field) return
      field.focus()
      if (document.activeElement !== field && tries++ < 40) frame = requestAnimationFrame(focus)
    }
    focus()
    return () => cancelAnimationFrame(frame)
  }, [])
  const apply = () => {
    const href = normalizeLinkTarget(value)
    // Nothing selected and no link here: the address goes in as its own linked text.
    if (href && editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: value.trim(), marks: [{ type: "link", attrs: { href } }] }).run()
      onDone()
      return
    }
    const chain = editor.chain().focus().extendMarkRange("link")
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run()
    onDone()
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Back to formatting"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDone}
        className="press inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[var(--color-text-foreground-secondary)] outline-hidden hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ArrowLeftIcon className="size-3.5" />
      </button>
      <input
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            apply()
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            onDone()
            editor.commands.focus()
          }
        }}
        aria-label="Link address"
        placeholder="Paste a link"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-7 w-56 rounded-md bg-transparent px-1.5 text-[length:var(--app-font-size-ui,12px)] text-foreground outline-hidden placeholder:text-muted-foreground/55"
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={apply}
        className="press h-7 cursor-pointer rounded-md px-2 text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground outline-hidden hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring"
      >
        {initial && !value.trim() ? "Remove" : "Apply"}
      </button>
    </div>
  )
}

/** The blocks a selection can become: the slash menu's list, as a column inside the bar. */
function TurnIntoList({ editor, current, onDone }: { editor: Editor; current: string; onDone: () => void }) {
  return (
    <div role="menu" aria-label="Turn into" className="flex w-44 flex-col gap-px">
      {TURN_INTO_ITEMS.map((item) => {
        const Icon = SLASH_ICONS[item.icon]
        const active = item.id === current
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            // Keep the text selected: a click here must not move focus out of the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!active) turnInto(editor, item)
              onDone()
            }}
            className="press flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-start text-[length:var(--app-font-size-ui,12px)] text-foreground outline-hidden transition-colors duration-100 hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon className="size-3.5 shrink-0 opacity-80" />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {active && <CheckIcon className="size-3 shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}

type Mode = "buttons" | "link" | "turn"

/** What a link points at, short enough to read at a glance. */
function linkLabel(href: string): string {
  if (/^kybern:\/\/thread\//i.test(href)) return "Thread link"
  return href.replace(/^(https?:\/\/|mailto:|tel:)/i, "").replace(/\/$/, "")
}

const BUBBLE_TEXT_BUTTON =
  "press h-7 cursor-pointer rounded-md px-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)] outline-hidden transition-colors duration-100 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"

export function FormatBar({ editor, selectionBar = true }: { editor: Editor; /** False on the Notes page, where the toolbar formats. */ selectionBar?: boolean }): ReactNode {
  const [mode, setMode] = useState<Mode>("buttons")
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      href: (current.getAttributes("link").href as string | undefined) ?? "",
      collapsed: current.state.selection.empty,
      block: currentBlockId(current),
    }),
  })
  // Once the selection is gone the bar is gone; the next one starts on its buttons.
  if (state.collapsed && mode !== "buttons") setMode("buttons")
  const blockTitle = TURN_INTO_ITEMS.find((item) => item.id === state.block)?.title ?? "Body"
  return (
    <>
      {selectionBar && <BubbleMenu
        editor={editor}
        pluginKey="noteFormatBar"
        options={{ placement: "top", offset: 8 }}
        shouldShow={({ editor: current, state: view }) =>
          current.isEditable && !view.selection.empty && !current.isActive("codeBlock") && (current.isFocused || mode !== "buttons")
        }
        className={cn(COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME, "note-format-bar z-40 flex items-center gap-0.5 p-1")}
      >
        {mode === "link" ? (
          <LinkField editor={editor} initial={state.href} onDone={() => setMode("buttons")} />
        ) : mode === "turn" ? (
          <TurnIntoList editor={editor} current={state.block} onDone={() => setMode("buttons")} />
        ) : (
          <>
            <button
              type="button"
              aria-label={`Turn into. Now ${blockTitle}`}
              aria-haspopup="menu"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setMode("turn")}
              className={cn(BUBBLE_TEXT_BUTTON, "inline-flex items-center gap-1 pe-1.5")}
            >
              <span className="max-w-24 truncate">{blockTitle}</span>
              <ChevronDownIcon className="size-3 opacity-60" aria-hidden="true" />
            </button>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
            <FormatButton icon={BoldIcon} label="Bold" shortcut={[mod, "B"]} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
            <FormatButton icon={ItalicIcon} label="Italic" shortcut={[mod, "I"]} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
            <FormatButton icon={StrikethroughIcon} label="Strikethrough" shortcut={[mod, "⇧", "S"]} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
            <FormatButton icon={CodeIcon} label="Code" shortcut={[mod, "E"]} active={state.code} onClick={() => editor.chain().focus().toggleCode().run()} />
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
            <FormatButton icon={LinkIcon} label={state.link ? "Edit link" : "Add link"} active={state.link} onClick={() => setMode("link")} />
          </>
        )}
      </BubbleMenu>}
      <BubbleMenu
        editor={editor}
        pluginKey="noteLinkBubble"
        options={{ placement: "bottom-start", offset: 6 }}
        shouldShow={({ editor: current, state: view }) => current.isEditable && current.isFocused && view.selection.empty && current.isActive("link")}
        className={cn(COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME, "note-link-bubble z-40 flex items-center gap-0.5 p-1")}
      >
        <span className="max-w-56 truncate ps-2 pe-1.5 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground" title={state.href}>
          {linkLabel(state.href)}
        </span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openNoteLink(state.href)} className={BUBBLE_TEXT_BUTTON} title={`Open link (${mod}-click)`}>
          Open
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // Select the whole link, then edit it in the bar (or the page's toolbar).
            editor.chain().focus().extendMarkRange("link").run()
            if (selectionBar) setMode("link")
            else useLinkEditRequest.setState({ editor })
          }}
          className={BUBBLE_TEXT_BUTTON}
        >
          Edit
        </button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()} className={BUBBLE_TEXT_BUTTON}>
          Remove
        </button>
      </BubbleMenu>
    </>
  )
}
