// Composer, to Synara's ChatView composer spec: frosted 1.2rem squircle
// surface, 12px system-ui editor, footer with the + menu, permission-mode
// picker (Full access in orange), model/effort picker and the ink send circle.
// Stacked panels (queued follow-ups, approval card, empty-landing tray) render
// through `above`, inside the same column frame.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { HiOutlineHandRaised } from "react-icons/hi2"
import { toast } from "sonner"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { ComposerColumnFrame } from "@/components/synara/chat/ComposerColumnFrame"
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
  RUNTIME_AUTO_ACCENT_CLASS_NAME,
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
} from "@/components/synara/chat/composerPickerStyles"
import { Kbd } from "@/components/synara/kbd"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from "@/components/synara/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { PROVIDER_LABEL, basename } from "@/lib/format"
import { CentralIcon } from "@/lib/synara/central-icons"
import { ChevronDownIcon, ComposerSendArrowIcon, FileIcon, PaperclipIcon, PencilIcon, PlusIcon, TerminalIcon, XIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { ContentPart, PermissionMode, ProjectId, ProviderInstance, ProviderStatus, UserMessage } from "@/protocol"
import { errorText, searchFiles, uploadFile } from "@/state/rpc"

export interface ComposerHandle {
  focus: () => void
  setText: (t: string) => void
  isEmpty: () => boolean
}

interface Attachment {
  id: string
  name: string
  media_type: string
  size: number
  preview?: string
}

export interface SlashCommand {
  name: string
  hint: string
  run: () => void
}

export interface ComposerProps {
  placeholder?: string
  running?: boolean
  disabled?: boolean
  disabledReason?: string
  onSend: (message: UserMessage) => Promise<void> | void
  onStop?: () => void
  mode: PermissionMode
  onModeChange: (m: PermissionMode) => void
  provider: ProviderInstance | null
  providers: ProviderStatus[]
  onProviderChange?: (p: ProviderInstance) => void
  model?: string | null
  effort?: string | null
  onModelChange?: (model: string | undefined, effort: string | undefined) => void
  /** Enables @ file mentions. */
  projectId?: ProjectId
  /** Slash commands offered when the text starts with "/". */
  commands?: SlashCommand[]
  /** Panels stacked above the input surface (queued, approval, landing tray). */
  above?: React.ReactNode
  /** Hides the footer row (pending approval). */
  hideFooter?: boolean
  autoFocus?: boolean
  className?: string
  /** 1..4 typed into an empty composer. Return true when handled. */
  onDigit?: (n: number) => boolean
}

const MODES: { mode: PermissionMode; label: string; description: string; icon: React.ReactNode }[] = [
  { mode: "supervised", label: "Ask for approval", description: "Always ask before editing files or running commands", icon: <HiOutlineHandRaised className="size-4" /> },
  { mode: "accept-edits", label: "Approve edits", description: "Edit files freely, ask before running commands", icon: <PencilIcon className="size-4" /> },
  { mode: "auto", label: "Approve for me", description: "Only ask for actions detected as potentially unsafe", icon: <CentralIcon name="shield-code" className="size-4" /> },
  { mode: "full-access", label: "Full access", description: "Unrestricted access to the internet and any file on your computer", icon: <CentralIcon name="shield-access" className="size-4" /> },
]

/** "claude-fable-5-1" -> "Claude Fable 5.1" when the catalog has no entry. */
function prettyModel(id: string): string {
  return id
    .replace(/^.*\//, "")
    .split("-")
    .map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2")
}

const EDITOR_CLASS =
  "block max-h-[200px] w-full resize-none overflow-y-auto bg-transparent font-system-ui text-[length:var(--app-font-size-chat,12px)] leading-relaxed break-words whitespace-pre-wrap text-foreground min-h-[var(--app-density-composer-editor-min-height,2lh)] placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-60 selectable"

const DEFAULT_PLACEHOLDER = "Ask anything, @tag files/folders, or use / to show available commands"

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    placeholder = DEFAULT_PLACEHOLDER,
    running,
    disabled,
    disabledReason,
    onSend,
    onStop,
    mode,
    onModeChange,
    provider,
    providers,
    onProviderChange,
    model,
    effort,
    onModelChange,
    projectId,
    commands = [],
    above,
    hideFooter,
    autoFocus,
    className,
    onDigit,
  } = props
  const [text, setText] = useState("")
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [menuSel, setMenuSel] = useState<{ sig: string; index: number }>({ sig: "", index: 0 })
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null)
  const mentioned = useRef(new Set<string>())
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${Math.min(200, el.scrollHeight)}px`
  }

  const setTextAndCaret = useCallback((next: string, pos?: number) => {
    setText(next)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      el.focus()
      const p = pos ?? next.length
      el.setSelectionRange(p, p)
      setCaret(p)
      grow(el)
    })
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t) => setTextAndCaret(t),
    isEmpty: () => text.trim().length === 0 && attachments.length === 0,
  }))

  useEffect(() => {
    if (autoFocus) ta.current?.focus()
  }, [autoFocus])

  // ---- @ mentions and / commands ----

  const mention = useMemo(() => {
    if (!projectId) return null
    const before = text.slice(0, caret)
    const at = before.lastIndexOf("@")
    if (at === -1) return null
    if (at > 0 && !/\s/.test(before[at - 1]!)) return null
    const query = before.slice(at + 1)
    if (/\s/.test(query)) return null
    return { start: at, query }
  }, [text, caret, projectId])

  const slash = useMemo(() => {
    if (!text.startsWith("/") || commands.length === 0) return null
    const token = text.slice(1, caret)
    if (/\s/.test(token)) return null
    const q = token.toLowerCase()
    const items = commands.filter((c) => c.name.startsWith(q))
    return items.length ? { query: token, items } : null
  }, [text, caret, commands])

  useEffect(() => {
    if (!mention || !projectId) return
    let live = true
    const id = setTimeout(() => {
      searchFiles(projectId, mention.query, 12)
        .then((r) => live && setFiles(r))
        .catch(() => live && setFiles([]))
    }, 60)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [mention, projectId])

  const menuKey = mention ? `@${mention.start}` : slash ? "/" : null
  const menuItems = mention ? files : (slash?.items.map((c) => c.name) ?? [])
  const menuOpen = !!menuKey && menuDismissed !== menuKey && (menuItems.length > 0 || !!mention)
  const menuSignature = `${menuKey}:${menuItems.length}`
  const menuIndex = menuSel.sig === menuSignature ? menuSel.index : 0
  const setMenuIndex = (f: number | ((i: number) => number)) => setMenuSel({ sig: menuSignature, index: typeof f === "function" ? f(menuIndex) : f })

  const pickMention = (path: string) => {
    if (!mention) return
    mentioned.current.add(path)
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`
    setTextAndCaret(next, mention.start + path.length + 2)
  }
  const pickCommand = (name: string) => {
    const cmd = commands.find((c) => c.name === name)
    if (!cmd) return
    setTextAndCaret("")
    cmd.run()
  }
  const pick = (i: number) => {
    const item = menuItems[i]
    if (!item) return
    if (mention) pickMention(item)
    else pickCommand(item)
  }

  // ---- sending ----

  const canSend = !disabled && !sending && uploading === 0 && (text.trim().length > 0 || attachments.length > 0)

  const buildParts = (): ContentPart[] => {
    const parts: ContentPart[] = []
    const t = text.trim()
    if (t) {
      const re = /@([^\s]+)/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(t))) {
        const path = m[1]!
        if (!mentioned.current.has(path)) continue
        const before = t.slice(last, m.index)
        if (before) parts.push({ type: "text", text: before })
        parts.push({ type: "file_mention", path })
        last = m.index + m[0].length
      }
      const rest = t.slice(last)
      if (rest || parts.length === 0) parts.push({ type: "text", text: rest })
    }
    for (const a of attachments) parts.push({ type: "attachment", asset_id: a.id, name: a.name, media_type: a.media_type, size: a.size })
    return parts
  }

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      await onSend({ parts: buildParts() })
      setText("")
      setAttachments([])
      mentioned.current.clear()
      if (ta.current) {
        ta.current.style.height = "auto"
        ta.current.focus()
      }
    } catch (e) {
      toast.error("Unable to send", { description: errorText(e) })
    } finally {
      setSending(false)
    }
  }

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const arr = Array.from(list)
    if (arr.length === 0) return
    setUploading((n) => n + arr.length)
    for (const f of arr) {
      try {
        const info = await uploadFile(f)
        const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined
        setAttachments((a) => [...a, { ...info, preview }])
      } catch (e) {
        toast.error(`Unable to attach ${f.name}`, { description: errorText(e) })
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && menuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % menuItems.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        pick(menuIndex)
        return
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault()
      setMenuDismissed(menuKey)
      return
    }
    const empty = !text.trim() && attachments.length === 0
    if (empty && onDigit && ["1", "2", "3", "4"].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (onDigit(Number(e.key))) {
        e.preventDefault()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length)

  // ---- model picker ----

  const status = provider ? providers.find((p) => p.kind === provider.kind) : undefined
  const models = status?.models ?? []
  const current =
    models.find((m) => (model ? m.id === model : m.is_default)) ??
    (model ? models.find((m) => m.id.startsWith(model) || model.startsWith(m.id)) : models[0])
  const modelLabel = current?.display_name ?? (model ? prettyModel(model) : null)
  const efforts = current?.efforts?.length ? current.efforts : (status?.supported_efforts ?? [])
  const effortLabel = effort ?? current?.default_effort ?? null
  const canPickModel = !!onModelChange && (models.length > 0 || efforts.length > 0)
  const canPickProvider = !!onProviderChange
  const modeInfo = MODES.find((m) => m.mode === mode) ?? MODES[0]!

  return (
    <ComposerColumnFrame className={className}>
      <div>{above}</div>
      <div
        className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, menuOpen && "overflow-visible")}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void addFiles(e.dataTransfer.files)
        }}
      >
        <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, menuOpen && "overflow-visible", dragOver && "border-[color:var(--color-border-focus)]")}>
          <div className={cn(COMPOSER_EDITOR_PADDING_CLASS_NAME, menuOpen && "overflow-visible")}>
            {menuOpen && (
              <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                <div className={COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME} role="listbox">
                  <div className="max-h-72 scroll-py-1 overflow-y-auto p-1">
                    {mention && menuItems.length === 0 ? (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground/50">{mention.query ? "No matching file." : "Type to search for files"}</p>
                    ) : (
                      <>
                        <div className="px-2 pt-1.5 pb-1 text-[11px] font-normal text-muted-foreground/60">{mention ? "Files" : "Built-in"}</div>
                        {menuItems.map((item, i) => {
                          const cmd = !mention ? commands.find((c) => c.name === item) : undefined
                          const active = i === menuIndex
                          return (
                            <button
                              key={item}
                              type="button"
                              role="option"
                              aria-selected={active}
                              onMouseEnter={() => setMenuIndex(i)}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => pick(i)}
                              className={cn("w-full", COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME, active && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME)}
                            >
                              <span className={cn("flex size-4 shrink-0 items-center justify-center", active ? "text-foreground/70" : "text-muted-foreground/60")}>
                                {mention ? <FileIcon className="size-3.5 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80" /> : <TerminalIcon className="size-3.5" />}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                                  <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">{mention ? basename(item) : titleCase(item)}</span>
                                  <span className="truncate text-[11px] text-muted-foreground/55">{mention ? "" : cmd?.hint}</span>
                                </div>
                                <span className="shrink-0 pl-2 text-right text-[10.5px] text-muted-foreground/42">{mention ? parentPath(item) : `/${item}`}</span>
                              </div>
                            </button>
                          )
                        })}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {(attachments.length > 0 || uploading > 0) && (
              <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
                {attachments.map((a) =>
                  a.preview ? (
                    <div key={a.id} className="group relative shrink-0">
                      <button
                        type="button"
                        className="block size-16 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] transition-colors hover:border-[color:var(--color-border)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <img src={a.preview} alt="" className="size-full object-cover" />
                      </button>
                      <RemoveButton name={a.name} onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))} />
                    </div>
                  ) : (
                    <span key={a.id} className="group relative inline-flex h-14 w-60 max-w-full items-center gap-2.5 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--composer-surface)] py-2 pr-8 pl-2 shadow-sm">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
                        <FileIcon className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
                        <span className="truncate text-[13px] font-medium text-foreground">{a.name}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase">{a.name.split(".").pop()}</span>
                      </span>
                      <RemoveButton name={a.name} onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))} />
                    </span>
                  ),
                )}
                {uploading > 0 && (
                  <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                    <Spinner size={14} /> Uploading…
                  </div>
                )}
              </div>
            )}

            <textarea
              ref={ta}
              data-testid="composer-editor"
              value={text}
              rows={1}
              placeholder={placeholder}
              aria-placeholder={placeholder}
              disabled={disabled}
              spellCheck
              onChange={(e) => {
                setText(e.target.value)
                syncCaret(e.target)
                grow(e.target)
                setMenuDismissed(null)
              }}
              onKeyUp={(e) => syncCaret(e.currentTarget)}
              onClick={(e) => syncCaret(e.currentTarget)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files)
                if (pasted.length) {
                  e.preventDefault()
                  void addFiles(pasted)
                }
              }}
              className={EDITOR_CLASS}
            />
          </div>

          {!hideFooter && (
            <div data-chat-composer-footer className={cn("@container", COMPOSER_FOOTER_ROW_CLASS_NAME, "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0")}>
              <div data-chat-composer-leading className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:min-w-max sm:overflow-visible [&::-webkit-scrollbar]:hidden">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files)
                    e.target.value = ""
                  }}
                />
                <Menu>
                  <MenuTrigger render={<Button size="icon-sm" variant="chrome" className="shrink-0 rounded-md" aria-label="Composer extras" />}>
                    <PlusIcon className="size-4 text-primary" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start">
                    <MenuGroup>
                      <MenuItem onClick={() => fileInput.current?.click()}>
                        <PaperclipIcon className="size-4 shrink-0" /> Add files
                      </MenuItem>
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>

                <div className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-foreground-secondary)]">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="chrome"
                          title={`${modeInfo.label}: ${modeInfo.description}. Click to change permissions.`}
                          className={cn(
                            "min-w-0 shrink-0 justify-start gap-1.5 px-2 whitespace-nowrap sm:px-2.5 [&_svg]:mx-0",
                            COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                            mode === "auto" && RUNTIME_AUTO_ACCENT_CLASS_NAME,
                            mode === "full-access" && RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
                          )}
                        />
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span className="[&>*]:size-3.5 [&>*]:shrink-0">{modeInfo.icon}</span>
                        <span className="truncate @max-[480px]:sr-only">{modeInfo.label}</span>
                        <ChevronDownIcon className="size-3 shrink-0 opacity-70 @max-[480px]:hidden" />
                      </span>
                    </MenuTrigger>
                    <ComposerPickerMenuPopup align="start" side="top" className="runtime-mode-menu w-[26rem] min-w-[26rem]">
                      <MenuRadioGroup value={mode} onValueChange={(v) => onModeChange(v as PermissionMode)} className="flex flex-col gap-1">
                        {MODES.map((m) => {
                          const supported = !status || status.supported_permission_modes.includes(m.mode)
                          return (
                            <MenuRadioItem
                              key={m.mode}
                              value={m.mode}
                              disabled={!supported}
                              className={cn(
                                "runtime-mode-menu-item",
                                m.mode === "auto" && "runtime-mode-menu-item--auto",
                                m.mode === "full-access" && "text-[var(--runtime-full-access-accent)] data-highlighted:text-[var(--runtime-full-access-accent)]",
                              )}
                            >
                              <span className="grid w-full min-w-0 flex-1 grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3">
                                <span className="flex h-5 items-center justify-center">{m.icon}</span>
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span>{m.label}</span>
                                  <span className={cn("runtime-mode-menu-description text-xs font-normal", m.mode === "full-access" ? "text-current" : "text-muted-foreground")}>{m.description}</span>
                                </span>
                              </span>
                            </MenuRadioItem>
                          )
                        })}
                      </MenuRadioGroup>
                    </ComposerPickerMenuPopup>
                  </Menu>
                </div>
              </div>

              <div data-chat-composer-actions="right" className="flex shrink-0 items-center gap-2">
                {provider && (
                  <Menu>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <MenuTrigger
                            disabled={!canPickModel && !canPickProvider}
                            render={
                              <Button
                                size="sm"
                                variant="chrome"
                                aria-label="Change model and reasoning"
                                className={cn("min-w-0 shrink-0 justify-start gap-1.5 px-2 whitespace-nowrap sm:px-2.5 [&_svg]:mx-0 disabled:opacity-100", COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME)}
                              />
                            }
                          />
                        }
                      >
                        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <ProviderMark kind={provider.kind} size={14} className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100" />
                          <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{modelLabel ?? PROVIDER_LABEL[provider.kind]}</span>
                          {modelLabel && effortLabel && <span className="shrink-0 text-muted-foreground capitalize">{effortLabel}</span>}
                          {(canPickModel || canPickProvider) && <ChevronDownIcon className="ms-0.5 size-3 shrink-0 opacity-60" />}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup side="top" sideOffset={6} variant="picker">
                        <span className="inline-flex items-center gap-2 px-1 py-0.5">Change model</span>
                      </TooltipPopup>
                    </Tooltip>
                    <ComposerPickerMenuPopup align="end" side="top" fixedWidth>
                      {efforts.length > 0 && canPickModel && (
                        <MenuGroup>
                          <MenuGroupLabel>Effort</MenuGroupLabel>
                          <MenuRadioGroup value={effortLabel ?? ""} onValueChange={(v) => onModelChange?.(current?.id ?? model ?? undefined, v as string)}>
                            {efforts.map((e) => (
                              <MenuRadioItem key={e} value={e}>
                                <span className="capitalize">{e}</span>
                                {e === current?.default_effort && <span className="ml-1 text-muted-foreground/60">(default)</span>}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                      )}
                      {models.length > 0 && canPickModel && (
                        <>
                          {efforts.length > 0 && <MenuSeparator />}
                          <MenuGroup>
                            <MenuSub>
                              <MenuSubTrigger>
                                <ProviderMark kind={provider.kind} size={12} className="size-3 shrink-0" />
                                <span className="truncate">{modelLabel ?? "Model"}</span>
                              </MenuSubTrigger>
                              <ComposerPickerMenuSubPopup fixedWidth className="[--available-height:min(20rem,55vh)]">
                                <MenuRadioGroup value={current?.id ?? ""} onValueChange={(v) => onModelChange?.(v as string, models.find((m) => m.id === v)?.default_effort ?? undefined)}>
                                  {models.map((m) => (
                                    <MenuRadioItem key={m.id} value={m.id}>
                                      <span className="truncate">{m.display_name}</span>
                                    </MenuRadioItem>
                                  ))}
                                </MenuRadioGroup>
                              </ComposerPickerMenuSubPopup>
                            </MenuSub>
                          </MenuGroup>
                        </>
                      )}
                      {canPickProvider && (
                        <>
                          {(models.length > 0 || efforts.length > 0) && <MenuSeparator />}
                          <MenuGroup>
                            <MenuGroupLabel>Agent</MenuGroupLabel>
                            <MenuRadioGroup value={provider.kind} onValueChange={(v) => onProviderChange?.({ kind: v as ProviderStatus["kind"], instance: "default" })}>
                              {providers.map((p) => (
                                <MenuRadioItem key={p.kind} value={p.kind} disabled={!p.available}>
                                  <ProviderMark kind={p.kind} size={12} className="size-3 shrink-0" />
                                  <span className="truncate">{p.display_name}</span>
                                  {!p.available && <span className="ml-auto text-[10px] text-muted-foreground/60">Not found</span>}
                                </MenuRadioItem>
                              ))}
                            </MenuRadioGroup>
                          </MenuGroup>
                        </>
                      )}
                    </ComposerPickerMenuPopup>
                  </Menu>
                )}

                {running ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="prominent"
                          size="icon-xs"
                          className="sm:size-[26px]"
                          aria-label="Stop generation"
                          title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                          onClick={onStop}
                          disabled={!onStop}
                        />
                      }
                    >
                      <span className="block size-2 rounded-[1px] bg-current" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{canSend ? "Stop. Press Enter to queue your message." : "Stop generation"}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="prominent"
                          size="icon-xs"
                          className="size-7 rounded-full sm:size-7"
                          aria-label={sending ? "Sending" : "Send message"}
                          disabled={!canSend}
                          onClick={() => void submit()}
                        />
                      }
                    >
                      {sending ? (
                        <svg width={12} height={12} viewBox="0 0 14 14" className="animate-spin" aria-hidden>
                          <circle cx={7} cy={7} r={5.5} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeDasharray="20 12" fill="none" />
                        </svg>
                      ) : (
                        <ComposerSendArrowIcon className="size-5 shrink-0 translate-y-px" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {disabled && disabledReason ? (
                        disabledReason
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          Send <Kbd className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)]">↵</Kbd>
                        </span>
                      )}
                    </TooltipPopup>
                  </Tooltip>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </ComposerColumnFrame>
  )
})

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      onClick={onClick}
      className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background shadow-sm transition-colors hover:bg-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <XIcon className="size-3" />
    </button>
  )
}

function titleCase(s: string): string {
  return s.replace(/(^|[-_ ])(\w)/g, (_m, sep: string, c: string) => `${sep === "-" || sep === "_" ? " " : sep}${c.toUpperCase()}`)
}

function parentPath(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

/** Empty-landing controls tray: stacked flush above the input, as Synara's `data-empty-landing-controls`. */
export function LandingTray({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-empty-landing-controls
      className="chat-composer-shell mx-auto flex min-h-8 w-14/15 min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden !rounded-t-[var(--composer-radius)] !rounded-b-none bg-[color-mix(in_srgb,var(--color-background-elevated-secondary)_76%,var(--color-background-surface)_24%)] px-2 py-1 transition-colors duration-150 ease-out motion-reduce:transition-none sm:min-h-7"
    >
      {children}
    </div>
  )
}

export function TrayChip({ icon, children, onClick, className }: { icon: React.ReactNode; children: React.ReactNode; onClick?: () => void; className?: string }) {
  if (!onClick) {
    return (
      <span className={cn("inline-flex max-w-56 min-w-0 shrink items-center gap-2 overflow-hidden rounded-full px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] sm:max-w-64", className)}>
        {icon}
        <span className="min-w-0 truncate">{children}</span>
      </span>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, className)}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDownIcon className="size-3 opacity-60" />
    </button>
  )
}
