// The document's floating toolbar: one slim material bar at the top of the page.
// Block style (Body ⌄), bold and italic, then checklist, bullets, code block,
// quote and link, then the outline. It is the page's only formatting control, so
// the selection bubble stays away; strikethrough and inline code keep their
// shortcuts and Markdown rules. The link button turns the bar into a link field.
import type { Editor } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { useState } from "react"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { mod } from "@/lib/format"
import { BoldIcon, CheckIcon, ChevronDownIcon, CodeBlockIcon, ItalicIcon, LinkIcon, ListBulletIcon, ListChecksIcon, OutlineIcon, QuoteIcon } from "@/lib/kit/icons"
import { FormatButton, LinkField } from "./FormatBar"
import { useLinkEditRequest } from "./linkEditRequest"
import { SLASH_ICONS } from "./slashIcons"
import { currentBlockId, TURN_INTO_ITEMS, turnInto } from "./slashItems"

export function NoteToolbar({ editor, outline, onToggleOutline }: { editor: Editor; outline: boolean | null; onToggleOutline: () => void }) {
  const [linking, setLinking] = useState(false)
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      checklist: current.isActive("taskList"),
      bullets: current.isActive("bulletList"),
      code: current.isActive("codeBlock"),
      quote: current.isActive("blockquote"),
      link: current.isActive("link"),
      href: (current.getAttributes("link").href as string | undefined) ?? "",
      block: currentBlockId(current),
    }),
  })

  // The link bubble's Edit opens the field here.
  const requested = useLinkEditRequest((s) => s.editor === editor)
  const linkOpen = linking || requested
  const closeLink = () => {
    setLinking(false)
    if (useLinkEditRequest.getState().editor === editor) useLinkEditRequest.setState({ editor: null })
  }

  const blockTitle = TURN_INTO_ITEMS.find((item) => item.id === state.block)?.title ?? "Body"
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => command(editor.chain().focus()).run()

  return (
    <div className="note-toolbar" role="toolbar" aria-label="Format">
      {linkOpen ? (
        <LinkField editor={editor} initial={state.href} onDone={closeLink} />
      ) : (
        <>
          <Menu>
            <MenuTrigger
              render={<button type="button" className="note-toolbar-text" aria-label={`Block style. Now ${blockTitle}`} onMouseDown={(event) => event.preventDefault()} />}
            >
              <span className="max-w-24 truncate">{blockTitle}</span>
              <ChevronDownIcon className="size-[11px] opacity-60" aria-hidden="true" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={8} className="action-menu min-w-44">
              <MenuGroup>
                {TURN_INTO_ITEMS.map((item) => {
                  const Icon = SLASH_ICONS[item.icon]
                  const active = item.id === state.block
                  return (
                    <MenuItem key={item.id} onClick={() => !active && turnInto(editor, item)}>
                      <Icon /> {item.title}
                      {active && <CheckIcon className="ms-auto" />}
                    </MenuItem>
                  )
                })}
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <i className="note-toolbar-sep" aria-hidden="true" />
          <FormatButton icon={BoldIcon} label="Bold" shortcut={[mod, "B"]} active={state.bold} onClick={() => run((c) => c.toggleBold())} />
          <FormatButton icon={ItalicIcon} label="Italic" shortcut={[mod, "I"]} active={state.italic} onClick={() => run((c) => c.toggleItalic())} />
          <i className="note-toolbar-sep" aria-hidden="true" />
          <FormatButton icon={ListChecksIcon} label="Checklist" shortcut={[mod, "⇧", "9"]} active={state.checklist} onClick={() => run((c) => c.toggleTaskList())} />
          <FormatButton icon={ListBulletIcon} label="Bullet list" shortcut={[mod, "⇧", "8"]} active={state.bullets} onClick={() => run((c) => c.toggleBulletList())} />
          <FormatButton icon={CodeBlockIcon} label="Code block" shortcut={[mod, "⌥", "C"]} active={state.code} onClick={() => run((c) => c.toggleCodeBlock())} />
          <FormatButton icon={QuoteIcon} label="Quote" shortcut={[mod, "⇧", "B"]} active={state.quote} onClick={() => run((c) => c.toggleBlockquote())} />
          <FormatButton icon={LinkIcon} label={state.link ? "Edit link" : "Add link"} active={state.link} onClick={() => setLinking(true)} />
          {outline !== null && (
            <>
              <i className="note-toolbar-sep" aria-hidden="true" />
              <FormatButton icon={OutlineIcon} label={outline ? "Collapse the outline" : "Keep the outline open"} active={outline} onClick={onToggleOutline} />
            </>
          )}
        </>
      )}
    </div>
  )
}
