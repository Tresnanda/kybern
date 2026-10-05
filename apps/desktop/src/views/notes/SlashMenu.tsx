// The "/" command menu. Tiptap's suggestion plugin drives a small controller;
// this panel reads it, so the editor can stay free of menu state.
import type { Editor } from "@tiptap/core"
import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

import {
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
} from "@/components/kit/chat/composerPickerStyles"
import { cn } from "@/lib/utils"
import type { SlashController } from "./slashController"
import { SLASH_ICONS } from "./slashIcons"


const MENU_WIDTH = 288
const GAP = 6
const EDGE = 8

type Position = { left: number; top?: number; bottom?: number }

/** Below the caret, or above it when there is no room below. */
function placeMenu(rect: DOMRect | null | undefined): Position | null {
  if (!rect) return null
  const below = window.innerHeight - rect.bottom
  const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE))
  return below < 320 && rect.top > below ? { left, bottom: window.innerHeight - rect.top + GAP } : { left, top: rect.bottom + GAP }
}

export function SlashMenu({ controller, editor }: { controller: SlashController; editor: Editor }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const position = state.open ? placeMenu(state.rect?.()) : null
  const showing = state.open && !!position
  const activeId = showing && state.items.length > 0 ? `${listId}-${state.index}` : undefined

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-slash-index="${state.index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [state.index, state.open])

  // Focus stays in the text, so the text field is what points at the highlighted option.
  useLayoutEffect(() => {
    if (!showing || !editor.isInitialized || editor.isDestroyed) return
    const dom = editor.view.dom
    dom.setAttribute("aria-controls", listId)
    dom.setAttribute("aria-haspopup", "listbox")
    dom.setAttribute("aria-expanded", "true")
    if (activeId) dom.setAttribute("aria-activedescendant", activeId)
    else dom.removeAttribute("aria-activedescendant")
    return () => {
      for (const name of ["aria-controls", "aria-haspopup", "aria-expanded", "aria-activedescendant"]) dom.removeAttribute(name)
    }
  }, [editor, showing, listId, activeId])

  if (!showing) return null
  return createPortal(
    <div
      id={listId}
      data-note-popover=""
      className={cn(COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME, "fixed z-50")}
      style={{ ...position, width: MENU_WIDTH }}
      role="listbox"
      aria-label="Insert"
    >
      <div ref={listRef} className="max-h-[min(20rem,45vh)] overflow-y-auto overscroll-contain p-1.5">
        {state.items.length === 0 ? (
          <p className="px-2.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">No blocks match “{state.query}”</p>
        ) : (
          state.items.map((item, index) => {
            const Icon = SLASH_ICONS[item.icon]
            const active = index === state.index
            return (
              <button
                key={item.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={active}
                data-slash-index={index}
                // Keep the editor's selection: the click must not take focus.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => controller.setIndex(index)}
                onClick={() => state.choose?.(item)}
                className={cn("w-full", COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME, active && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-foreground/85">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">{item.title}</span>
                {item.shortcut && (
                  <span aria-hidden="true" className="shrink-0 font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
                    {item.shortcut}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>,
    document.body,
  )
}
