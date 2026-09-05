// Composer, to Synara's ChatView composer spec: frosted 1.2rem squircle
// surface, 12px system-ui editor, footer with the + menu, permission-mode
// picker (Full access in orange), model/effort picker and the ink send circle.
// Stacked panels (queued follow-ups, approval card, empty-landing tray) render
// through `above`, inside the same column frame.

import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { HiOutlineHandRaised } from "react-icons/hi2"
import { toast } from "sonner"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { ComposerColumnFrame } from "@/components/synara/chat/ComposerColumnFrame"
import { FileEntryIcon } from "@/components/synara/chat/FileEntryIcon"
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ICON_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TEXT_SIZE_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
  COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
  RUNTIME_AUTO_ACCENT_CLASS_NAME,
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
} from "@/components/synara/chat/composerPickerStyles"
import { Kbd } from "@/components/synara/kbd"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from "@/components/synara/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { buildStructuredTextParts } from "@/lib/composerTokens"
import { PROVIDER_LABEL, basename } from "@/lib/format"
import { CentralIcon } from "@/lib/synara/central-icons"
import { ChevronDownIcon, ComposerSendArrowIcon, PaperclipIcon, PencilIcon, PlusIcon, RefreshCwIcon, SkillCubeIcon, TerminalIcon, XIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { ContentPart, PermissionMode, ProjectId, ProviderInstance, ProviderStatus, SkillInfo, UserMessage } from "@/protocol"
import { errorText, listSkills, refreshProviders, searchFiles, uploadFile } from "@/state/rpc"
import { useStore } from "@/state/store"

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
  icon?: React.ReactNode
  run: () => void
}

export interface ComposerProps {
  /** Unique within the selected environment: a thread or project draft. */
  draftKey?: string
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
  /** Adapts the footer and surface geometry to a constrained split pane. */
  surfaceMode?: "single" | "split"
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

const DEFAULT_PLACEHOLDER = "Ask anything, @ files, $ skills, or / commands"

type ComposerMenuItem =
  | { id: string; type: "file"; path: string }
  | { id: string; type: "command"; command: SlashCommand }
  | { id: string; type: "skill"; skill: SkillInfo }

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  if (haystack === needle) return 0
  if (haystack.startsWith(needle)) return 1
  const boundary = haystack.search(new RegExp(`(?:^|[\\s:_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  if (boundary >= 0) return 2 + boundary / 100
  const included = haystack.indexOf(needle)
  if (included >= 0) return 4 + included / 100
  let at = 0
  for (const character of needle) {
    at = haystack.indexOf(character, at)
    if (at < 0) return null
    at += 1
  }
  return 10 + (haystack.length - needle.length) / 100
}

function rankSkills(skills: readonly SkillInfo[], query: string, limit = 12): SkillInfo[] {
  return skills
    .filter((skill) => skill.enabled)
    .flatMap((skill) => {
      const scores = [skill.name, skill.display_name ?? "", skill.description ?? ""].flatMap((value) => {
        const score = fuzzyScore(value, query)
        return score == null ? [] : [score]
      })
      return scores.length ? [{ skill, score: Math.min(...scores) }] : []
    })
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map(({ skill }) => skill)
}

function skillSourceLabel(scope: SkillInfo["scope"]): string {
  switch (scope) {
    case "project":
      return "Project"
    case "repo":
      return "Repo"
    case "user":
      return "Personal"
    case "app":
      return "App"
    case "system":
    case "admin":
      return "System"
    default:
      return "Provider"
  }
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files)
  if (files.length > 0) return files
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    placeholder = DEFAULT_PLACEHOLDER,
    running,
    disabled: disabledByParent,
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
    surfaceMode = "single",
    onDigit,
  } = props
  const [ownerStore] = useState(() => useStore)
  const [savedDraft] = useState(() => props.draftKey ? ownerStore.getState().composerDrafts[props.draftKey] : undefined)
  const connected = useStore((s) => s.connection.state === "open")
  const disabled = disabledByParent || !connected
  const [text, setText] = useState(savedDraft?.text ?? "")
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>(savedDraft?.attachments ?? [])
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [fileResult, setFileResult] = useState<{ query: string; files: string[] }>({ query: "", files: [] })
  const [skillCatalog, setSkillCatalog] = useState<{ key: string; skills: SkillInfo[] }>({ key: "", skills: [] })
  const [menuSel, setMenuSel] = useState<{ sig: string; index: number }>({ sig: "", index: 0 })
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null)
  const mentioned = useRef(new Set<string>(savedDraft?.mentions ?? []))
  const selectedSkills = useRef(new Map<string, SkillInfo>((savedDraft?.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill])))
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuList = useRef<HTMLDivElement>(null)
  const previewUrls = useRef(new Set<string>())

  useLayoutEffect(() => {
    const key = props.draftKey
    if (!key) return
    ownerStore.getState().set((state) => {
      const composerDrafts = { ...state.composerDrafts }
      if (text || attachments.length) {
        composerDrafts[key] = {
          text, attachments: attachments.map(({ id, name, media_type, size }) => ({ id, name, media_type, size })),
          mentions: [...mentioned.current], skills: [...selectedSkills.current.values()],
        }
      } else delete composerDrafts[key]
      return { composerDrafts }
    })
  }, [text, attachments, ownerStore, props.draftKey])

  useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    },
    [],
  )

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

  // ---- @ files, $ skills, and / commands ----

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
    const before = text.slice(0, caret)
    if (!before.startsWith("/")) return null
    const token = before.slice(1)
    if (/\s/.test(token)) return null
    const skillOnly = token.toLowerCase().startsWith("skill:")
    return { query: skillOnly ? token.slice(6) : token, skillOnly }
  }, [text, caret])

  const skill = useMemo(() => {
    if (!projectId || !provider) return null
    const before = text.slice(0, caret)
    const dollar = before.lastIndexOf("$")
    if (dollar < 0 || (dollar > 0 && !/\s/.test(before[dollar - 1]!))) return null
    const query = before.slice(dollar + 1)
    if (!/^(?:[A-Za-z][A-Za-z0-9:_-]*)?$/.test(query)) return null
    return { start: dollar, query }
  }, [text, caret, projectId, provider])

  useEffect(() => {
    if (!mention || !projectId) return
    let live = true
    const id = setTimeout(() => {
      searchFiles(projectId, mention.query, 12)
        .then((files) => live && setFileResult({ query: mention.query, files }))
        .catch(() => live && setFileResult({ query: mention.query, files: [] }))
    }, 60)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [mention, projectId])

  const skillCatalogKey = projectId && provider ? `${projectId}:${provider.kind}` : ""
  const needsSkills = !!skill || !!slash
  useEffect(() => {
    selectedSkills.current.clear()
  }, [skillCatalogKey])
  useEffect(() => {
    if (!needsSkills || !projectId || !provider || skillCatalog.key === skillCatalogKey) return
    let live = true
    listSkills(projectId, provider.kind)
      .then((skills) => live && setSkillCatalog({ key: skillCatalogKey, skills }))
      .catch(() => live && setSkillCatalog({ key: skillCatalogKey, skills: [] }))
    return () => {
      live = false
    }
  }, [needsSkills, projectId, provider, skillCatalog.key, skillCatalogKey])

  const skills = useMemo(() => (skillCatalog.key === skillCatalogKey ? skillCatalog.skills : []), [skillCatalog, skillCatalogKey])
  const files = useMemo(() => (fileResult.query === mention?.query ? fileResult.files : []), [fileResult, mention?.query])
  const menuItems = useMemo<ComposerMenuItem[]>(() => {
    if (mention) return files.map((path) => ({ id: `file:${path}`, type: "file", path }))
    if (skill) return rankSkills(skills, skill.query).map((item) => ({ id: `skill:${item.name}`, type: "skill", skill: item }))
    if (!slash) return []
    const commandItems = slash.skillOnly
      ? []
      : commands
          .flatMap((command) => {
            const scores = [fuzzyScore(command.name, slash.query), fuzzyScore(command.hint, slash.query)].filter((score): score is number => score != null)
            return scores.length ? [{ command, score: Math.min(...scores) }] : []
          })
          .sort((left, right) => left.score - right.score)
          .map(({ command }) => ({ id: `command:${command.name}`, type: "command" as const, command }))
    const skillItems = rankSkills(skills, slash.query).map((item) => ({ id: `skill:${item.name}`, type: "skill" as const, skill: item }))
    return [...commandItems, ...skillItems].slice(0, 16)
  }, [commands, files, mention, skill, skills, slash])
  const menuKey = mention ? `@${mention.start}` : skill ? `$${skill.start}` : slash ? "/" : null
  const menuOpen = !!menuKey && menuDismissed !== menuKey
  const menuSignature = `${menuKey}:${menuItems.map((item) => item.id).join("|")}`
  const menuIndex = menuSel.sig === menuSignature ? menuSel.index : 0
  const setMenuIndex = (f: number | ((i: number) => number)) => setMenuSel({ sig: menuSignature, index: typeof f === "function" ? f(menuIndex) : f })

  useLayoutEffect(() => {
    if (!menuOpen) return
    menuList.current?.querySelector<HTMLElement>(`[data-menu-index="${menuIndex}"]`)?.scrollIntoView({ block: "nearest" })
  }, [menuIndex, menuOpen, menuSignature])

  const pickMention = (path: string) => {
    if (!mention) return
    mentioned.current.add(path)
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`
    setTextAndCaret(next, mention.start + path.length + 2)
  }
  const pickCommand = (cmd: SlashCommand) => {
    setTextAndCaret("")
    cmd.run()
  }
  const pickSkill = (item: SkillInfo) => {
    selectedSkills.current.set(item.name.toLowerCase(), item)
    const trigger = skill ?? (slash ? { start: 0, query: slash.query } : null)
    if (!trigger) return
    const token = `$${item.name} `
    const next = `${text.slice(0, trigger.start)}${token}${text.slice(caret)}`
    setTextAndCaret(next, trigger.start + token.length)
  }
  const pick = (i: number) => {
    const item = menuItems[i]
    if (!item) return
    if (item.type === "file") pickMention(item.path)
    else if (item.type === "command") pickCommand(item.command)
    else pickSkill(item.skill)
  }

  // ---- sending ----

  const canSend = !disabled && !sending && uploading === 0 && (text.trim().length > 0 || attachments.length > 0)

  const buildParts = (): ContentPart[] => {
    const skillItems = [...skills, ...selectedSkills.current.values()]
    const parts = buildStructuredTextParts(text, mentioned.current, skillItems)
    for (const a of attachments) parts.push({ type: "attachment", asset_id: a.id, name: a.name, media_type: a.media_type, size: a.size })
    return parts
  }

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      await onSend({ parts: buildParts() })
      if (props.draftKey) ownerStore.getState().set((state) => {
        const composerDrafts = { ...state.composerDrafts }
        delete composerDrafts[props.draftKey!]
        return { composerDrafts }
      })
      setText("")
      for (const attachment of attachments) {
        if (attachment.preview) {
          URL.revokeObjectURL(attachment.preview)
          previewUrls.current.delete(attachment.preview)
        }
      }
      setAttachments([])
      mentioned.current.clear()
      selectedSkills.current.clear()
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
      if (ownerStore !== useStore) break
      try {
        const info = await uploadFile(f)
        if (ownerStore !== useStore) break
        const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined
        if (preview) previewUrls.current.add(preview)
        setAttachments((a) => [...a, { ...info, preview }])
      } catch (e) {
        toast.error(`Unable to attach ${f.name}`, { description: errorText(e) })
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }, [ownerStore])

  const removeAttachment = (attachment: Attachment) => {
    if (attachment.preview) {
      URL.revokeObjectURL(attachment.preview)
      previewUrls.current.delete(attachment.preview)
    }
    setAttachments((list) => list.filter((item) => item.id !== attachment.id))
  }

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
    (model ? models.find((m) => m.id.startsWith(model) || model.startsWith(m.id)) : undefined)
  const modelLabel = current?.display_name ?? (model ? prettyModel(model) : null)
  const efforts = current?.efforts?.length ? current.efforts : (status?.supported_efforts ?? [])
  const effortLabel = effort ?? current?.default_effort ?? null
  const canPickModel = !!onModelChange && (models.length > 0 || efforts.length > 0)
  const canReloadModels = !!onModelChange && !!status?.available && status.supports_model_switch && models.length === 0
  const canPickProvider = !!onProviderChange
  const modeInfo = MODES.find((m) => m.mode === mode) ?? MODES[0]!
  const menuLoading = mention ? fileResult.query !== mention.query : (!!skill || !!slash) && skillCatalog.key !== skillCatalogKey
  const menuEmptyText = menuLoading
    ? mention
      ? "Searching project files…"
      : "Loading agent skills…"
    : mention
      ? mention.query
        ? "No matching files"
        : "Type to search project files"
      : skill
        ? "No matching skills"
        : "No matching commands or skills"

  const reloadModels = async () => {
    if (!provider || modelCatalogLoading) return
    setModelCatalogLoading(true)
    try {
      const refreshed = await refreshProviders(projectId)
      const count = refreshed.find((item) => item.kind === provider.kind)?.models?.length ?? 0
      if (count === 0) {
        const description = provider.kind === "omp"
          ? "Run omp models ls --json and check the provider login, then reload models."
          : "Check the provider login, then reload models."
        toast.error("Models are still unavailable", { description })
      }
    } catch (error) {
      toast.error("Unable to reload models", { description: errorText(error) })
    } finally {
      setModelCatalogLoading(false)
    }
  }

  return (
    <ComposerColumnFrame className={cn(className, surfaceMode === "split" && "split-chat-composer")}>
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
                  <div ref={menuList} className="max-h-72 scroll-py-1 overflow-y-auto overscroll-contain p-1.5">
                    {menuItems.length === 0 ? (
                      <p className="px-2.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground/60">{menuEmptyText}</p>
                    ) : (
                      menuItems.map((item, i) => {
                        const active = i === menuIndex
                        const previous = menuItems[i - 1]
                        const section = item.type === "file" ? "Files" : item.type === "command" ? "Commands" : "Skills"
                        const previousSection = previous?.type === "file" ? "Files" : previous?.type === "command" ? "Commands" : previous ? "Skills" : null
                        const title =
                          item.type === "file"
                            ? basename(item.path)
                            : item.type === "command"
                              ? titleCase(item.command.name)
                              : `$${item.skill.name}`
                        const description = item.type === "command" ? item.command.hint : item.type === "skill" ? item.skill.description : null
                        return (
                          <Fragment key={item.id}>
                            {section !== previousSection && (
                              <div className={cn("px-2.5 pb-1 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground/60", i > 0 ? "pt-2.5" : "pt-1")}>
                                {section}
                              </div>
                            )}
                            <button
                              type="button"
                              data-menu-index={i}
                              role="option"
                              aria-selected={active}
                              onMouseEnter={() => setMenuIndex(i)}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => pick(i)}
                              className={cn("w-full", COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME, active && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME)}
                            >
                              <span className={cn("flex size-4 shrink-0 items-center justify-center", active ? "text-foreground/80" : "text-muted-foreground/70")}>
                                {item.type === "file" ? (
                                  <FileEntryIcon pathValue={item.path} kind="file" className="size-4" />
                                ) : item.type === "skill" ? (
                                  <SkillCubeIcon className="size-4" />
                                ) : (
                                  item.command.icon ?? <TerminalIcon className="size-4" />
                                )}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                  <span className="max-w-[45%] shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/90">{title}</span>
                                  {description && <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">{description}</span>}
                                </div>
                                {item.type === "file" ? (
                                  <span className="max-w-[42%] shrink truncate text-end text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">{parentPath(item.path)}</span>
                                ) : item.type === "command" ? (
                                  <span className="shrink-0 text-end font-chat-code text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">/{item.command.name}</span>
                                ) : (
                                  <span className="shrink-0 rounded-full bg-[var(--color-background-button-secondary)] px-2 py-0.5 text-[length:var(--app-font-size-ui-2xs,10px)] font-medium text-muted-foreground/70">
                                    {skillSourceLabel(item.skill.scope)}
                                  </span>
                                )}
                              </div>
                            </button>
                          </Fragment>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {(attachments.length > 0 || uploading > 0) && (
              <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
                {attachments.map((a) =>
                  a.preview ? (
                    <div key={a.id} className="group relative size-16 shrink-0 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)]">
                        <img src={a.preview} alt="" className="size-full object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10" />
                      <RemoveButton name={a.name} onClick={() => removeAttachment(a)} />
                    </div>
                  ) : (
                    <span key={a.id} className="group relative inline-flex h-14 w-60 max-w-full items-center gap-2.5 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--composer-surface)] py-2 pr-8 pl-2 shadow-sm">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
                        <FileEntryIcon pathValue={a.name} kind="file" mimeType={a.media_type} className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
                        <span className="truncate text-[13px] font-medium text-foreground">{a.name}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase">{a.name.split(".").pop()}</span>
                      </span>
                      <RemoveButton name={a.name} onClick={() => removeAttachment(a)} />
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
                setMenuSel({ sig: "", index: 0 })
                setMenuDismissed(null)
              }}
              onKeyUp={(e) => syncCaret(e.currentTarget)}
              onClick={(e) => syncCaret(e.currentTarget)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = clipboardFiles(e.clipboardData)
                if (pasted.length) {
                  e.preventDefault()
                  void addFiles(pasted)
                }
              }}
              className={EDITOR_CLASS}
            />
          </div>

          {!hideFooter && (
            <div
              data-chat-composer-footer
              className={cn(
                "@container",
                COMPOSER_FOOTER_ROW_CLASS_NAME,
                surfaceMode === "split" ? "min-w-0 flex-nowrap gap-1" : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
              )}
            >
              <div
                data-chat-composer-leading
                className={cn(
                  "flex min-w-0 items-center gap-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  surfaceMode === "split" ? "shrink-0 overflow-visible" : "flex-1 overflow-x-auto sm:min-w-max sm:overflow-visible",
                )}
              >
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
                  <MenuTrigger render={<Button size="icon-xs" variant="chrome" className={COMPOSER_FOOTER_ICON_BUTTON_CLASS_NAME} aria-label="Composer extras" />}>
                    <PlusIcon aria-hidden className="size-[18px] text-[var(--color-text-foreground)]" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start">
                    <MenuGroup>
                      <MenuItem onClick={() => fileInput.current?.click()}>
                        <PaperclipIcon className="size-4 shrink-0" /> Add files
                      </MenuItem>
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>

                <Menu>
                  <MenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="chrome"
                          title={`${modeInfo.label}: ${modeInfo.description}. Click to change permissions.`}
                          className={cn(
                            COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
                            COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                            COMPOSER_FOOTER_PICKER_TEXT_SIZE_CLASS_NAME,
                            mode === "auto" && RUNTIME_AUTO_ACCENT_CLASS_NAME,
                            mode === "full-access" && RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
                          )}
                        />
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-flex size-4 shrink-0 items-center justify-center [&>*]:size-4 [&>*]:shrink-0">{modeInfo.icon}</span>
                        <span className={cn("truncate leading-none @max-[480px]:sr-only", surfaceMode === "split" && "sr-only")}>{modeInfo.label}</span>
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

              <div
                data-chat-composer-actions="right"
                className={cn("flex items-center gap-1", surfaceMode === "split" ? "min-w-0 flex-1 justify-end" : "shrink-0")}
              >
                {provider && (
                  <Menu onOpenChange={(open) => open && canReloadModels && void reloadModels()}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <MenuTrigger
                            disabled={!canPickModel && !canReloadModels && !canPickProvider}
                            render={
                              <Button
                                size="sm"
                                variant="chrome"
                                aria-label="Change model and reasoning"
                                title={`${modelLabel ?? PROVIDER_LABEL[provider.kind]}${effortLabel ? `, ${effortLabel} effort` : ""}`}
                                className={cn(
                                  COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
                                  "disabled:opacity-100",
                                  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                                  COMPOSER_FOOTER_PICKER_TEXT_SIZE_CLASS_NAME,
                                  surfaceMode === "split" && "max-w-full shrink overflow-hidden px-2 sm:px-2",
                                )}
                              />
                            }
                          />
                        }
                      >
                        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <ProviderMark kind={provider.kind} size={14} className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100" />
                          <span className="min-w-0 truncate leading-none text-[var(--color-text-foreground)]">{modelLabel ?? PROVIDER_LABEL[provider.kind]}</span>
                          {modelLabel && effortLabel && (
                            <span
                              className={cn(
                                "shrink-0 capitalize leading-none",
                                COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
                                surfaceMode === "split" && "@max-[620px]:hidden",
                              )}
                            >
                              {effortLabel}
                            </span>
                          )}
                          {(canPickModel || canReloadModels || canPickProvider) && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup side="top" sideOffset={6} variant="picker">
                        <span className="inline-flex items-center gap-2 px-1 py-0.5">Change model</span>
                      </TooltipPopup>
                    </Tooltip>
                    <ComposerPickerMenuPopup align="end" side="top" fixedWidth>
                      {canReloadModels && (
                        <MenuGroup>
                          <MenuGroupLabel>Model</MenuGroupLabel>
                          <MenuItem onClick={() => void reloadModels()} disabled={modelCatalogLoading}>
                            {modelCatalogLoading ? <Spinner size={12} /> : <RefreshCwIcon className="size-3" />}
                            <span>{modelCatalogLoading ? "Loading models…" : "Reload models"}</span>
                          </MenuItem>
                        </MenuGroup>
                      )}
                      {efforts.length > 0 && canPickModel && (
                        <MenuGroup className={canReloadModels ? "mt-1" : undefined}>
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
                          {(models.length > 0 || efforts.length > 0 || canReloadModels) && <MenuSeparator />}
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
                          className={cn(COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME, surfaceMode === "split" && "!size-7 sm:!size-7")}
                          aria-label="Stop generation"
                          title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                          onClick={onStop}
                          disabled={!onStop}
                        />
                      }
                    >
                      <span className="block size-2.5 rounded-[2px] bg-current" />
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
                          className={cn(COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME, surfaceMode === "split" && "!size-7 sm:!size-7")}
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
      className="chat-composer-shell mx-auto flex min-h-8 w-14/15 min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden !rounded-t-[var(--composer-radius)] !rounded-b-none bg-[var(--composer-backing-surface)] px-2 py-1 transition-colors duration-150 ease-out motion-reduce:transition-none sm:min-h-7"
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
