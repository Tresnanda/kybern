import { ComposerImageAttachment } from "@/components/kybern/ComposerImageAttachment"
import { PromptCacheIndicator } from "@/components/kybern/PromptCacheIndicator"
import { ProviderUsageIndicator } from "@/components/kybern/ProviderUsageIndicator"
import type { PromptCacheWindow } from "@/lib/promptCache"
import type { ProviderUsage } from "@/protocol"
// Composer: frosted 1.2rem squircle
// surface, 12px system-ui editor, footer with the + menu, permission-mode
// picker (Full access in orange), model/effort picker and the ink send circle.
// Stacked panels (queued follow-ups, approval card, empty-landing tray) render
// through `above`, inside the same column frame.

import { Fragment, forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { ComposerColumnFrame } from "@/components/kit/chat/ComposerColumnFrame"
import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { ComposerMentionChips } from "@/components/kit/chat/ComposerMentionChips"
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_FOOTER_ICON_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TEXT_SIZE_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
  COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_SEND_GLYPH_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
  RUNTIME_AUTO_ACCENT_CLASS_NAME,
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
} from "@/components/kit/chat/composerPickerStyles"
import { Kbd } from "@/components/kit/kbd"
import { Menu, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { buildStructuredTextParts, createComposerMentionReference, nextAttachmentLabel, structuredSegments, type AttachmentReference, type ComposerMentionReference } from "@/lib/composerTokens"
import { createComposerThreadReference, type ComposerThreadReference } from "../../../../packages/kybern-client/src/threadReferences"
import { PROVIDER_LABEL, basename, formatEffort, isMac, mod } from "@/lib/format"
import { ChevronDownIcon, ClockIcon, ComposerSendArrowIcon, MessageCircleIcon, NoteIcon, PaperclipIcon, PencilIcon, PlusIcon, PluginIcon, DeviceLaptopIcon,
  HandRaisedIcon, ShieldCheckIcon, ShieldIcon, SkillCubeIcon, TerminalIcon, XIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { IconSwap } from "@/components/kybern/motion"
import { ComposerEditor, type ComposerEditorHandle, type EditorSegment } from "@/components/kit/chat/ComposerEditor"
import { isFreeChatProject, type ContentPart, type NoteId, type NoteSummary, type PermissionMode, type ProjectId, type ProviderInstance, type ProviderStatus, type SkillInfo, type TaskItem, type TaskItemId, type Thread, type UserMessage } from "@/protocol"
import { errorText, listSkills, refreshProviders, rpc, searchFiles, uploadFile } from "@/state/rpc"
import { useStore } from "@/state/store"
import { COMPUTER_MENTION_PATH, COMPUTER_MENTION_SKILL, noteMentionPart, taskMentionPart, type MentionPart } from "@/lib/userInput"
import { mentionTokenKind } from "@/lib/inlineTokenLabel"
import { isHomeShared, noteClient, useNotes } from "@/state/notes"
import { noteScopeLabel, noteTitle } from "@/state/notesModel"
import { useTasks } from "@/state/tasks"
import { keyMatchesQuery, PRIORITY_LABEL, STATUS_LABEL } from "@/state/tasksModel"
import { PriorityGlyph, TaskStatusGlyph } from "./tasks/TaskGlyphs"
import {
  fuzzyScore,
  MENTION_ALL_PER_KIND,
  MENTION_FILTER_LABEL,
  MENTION_KINDS,
  mentionArrowsSwitchChips,
  mentionAtCaret,
  parseMentionQuery,
  rankMentionNotes,
  rankMentionTasks,
  type MentionFilter,
  type MentionKind,
} from "./composerMentions"
import { SendCancelled } from "./sendCancelled"
import { findModel, modelQualifier } from "../../../../packages/kybern-client/src/models"
import { isChildThread } from "../../../../packages/kybern-client/src/subagents.ts"
import { ModelPicker } from "@/components/kybern/ModelPicker"

export interface ComposerHandle {
  focus: () => void
  setText: (t: string) => void
  isEmpty: () => boolean
  /**
   * Insert a mention chip at the caret (or the end), followed by a space, and
   * focus the editor. Build note and task parts with `noteMentionPart` /
   * `taskMentionPart` from `lib/userInput`. A path already shown is left alone.
   */
  insertMention: (part: MentionPart) => void
  /** Remove every chip for this mention path. */
  removeMention: (path: string) => void
  /** The note and task chips currently in the text, oldest pick first. */
  mentions: () => MentionPart[]
  /** Send what is written, as the send button would. */
  submit: () => void
}

interface Attachment {
  id: string
  name: string
  media_type: string
  size: number
  /** Inline label (`image1`) the prompt can mention as `@image1`. */
  label: string
  preview?: string
}

/** Label restored drafts that predate inline attachment mentions. */
function labelAttachments<T extends { media_type: string; label?: string }>(list: readonly T[]): (T & { label: string })[] {
  const taken: string[] = list.flatMap((item) => (item.label ? [item.label] : []))
  return list.map((item) => {
    if (item.label) return { ...item, label: item.label }
    const label = nextAttachmentLabel(item.media_type, taken)
    taken.push(label)
    return { ...item, label }
  })
}

/** Saved with the draft beside the store's typed fields: note and task chips. */
type DraftMentionExtras = { mentionReferences?: ComposerMentionReference[] }

const NO_NOTES: Record<NoteId, NoteSummary> = {}
const NO_TASKS: Record<TaskItemId, TaskItem> = {}

const attachmentPart = (a: Attachment): AttachmentReference["part"] => ({ type: "attachment", asset_id: a.id, name: a.name, media_type: a.media_type, size: a.size })

export interface SlashCommand {
  name: string
  hint: string
  icon?: React.ReactNode
  invocation?: string
  insert?: boolean
  run: () => void
}

export interface ComposerProps {
  /** Unique within the selected environment: a thread or project draft. */
  providerUsage?: ProviderUsage
  showProviderUsage?: boolean
  promptCache?: { window: PromptCacheWindow; lastActivityAt: string }
  draftKey?: string
  placeholder?: string
  running?: boolean
  disabled?: boolean
  sendDisabled?: boolean
  disabledReason?: string
  onSend: (message: UserMessage) => Promise<void> | void
  onSteer?: (message: UserMessage) => Promise<void> | void
  onStop?: () => void
  mode: PermissionMode
  onModeChange: (m: PermissionMode) => void
  provider: ProviderInstance | null
  accountControl?: React.ReactNode
  providerSessionId?: string | null
  providers: ProviderStatus[]
  /** `choice` carries a model picked from another harness's favorites. */
  onProviderChange?: (p: ProviderInstance, choice?: { model?: string; effort?: string }) => Promise<void> | void
  model?: string | null
  effort?: string | null
  onModelChange?: (model: string | undefined, effort: string | undefined) => Promise<void> | void
  /** Enables @ file mentions and the skill catalog; also ranks this project's threads, notes and tasks first. */
  projectId?: ProjectId
  /**
   * Chips the composer starts with when it has no saved draft, e.g. the task on
   * a task page. Until the person edits it, this prefill is not saved as a draft.
   */
  initialMentions?: readonly MentionPart[]
  /** Slash commands offered at a word boundary. */
  commands?: SlashCommand[]
  /** Panels stacked above the input surface (queued, approval, landing tray). */
  above?: React.ReactNode
  /** Hides the footer row (pending approval). */
  hideFooter?: boolean
  /** A structured question panel temporarily takes the place of the editor. */
  hideInput?: boolean
  autoFocus?: boolean
  className?: string
  /** Adapts the footer and surface geometry to a constrained split pane. */
  surfaceMode?: "single" | "split"
  /** 1..4 typed into an empty composer. Return true when handled. */
  onDigit?: (n: number) => boolean
  /**
   * Words for the send button when the arrow cannot say enough ("Start 3 runs"). The
   * button becomes a labeled pill; the label is also its accessible name.
   */
  sendLabel?: string
  /** The note and task chips in the text, called when they change (and once on mount). */
  onMentionsChange?: (mentions: MentionPart[]) => void
}

const MODES: { mode: PermissionMode; label: string; description: string; icon: React.ReactNode }[] = [
  { mode: "supervised", label: "Ask for approval", description: "Always ask before editing files or running commands", icon: <HandRaisedIcon className="size-4" /> },
  { mode: "accept-edits", label: "Approve edits", description: "Edit files freely, ask before running commands", icon: <PencilIcon className="size-4" /> },
  { mode: "auto", label: "Approve for me", description: "Only ask for actions detected as potentially unsafe", icon: <ShieldCheckIcon className="size-4" /> },
  { mode: "full-access", label: "Full access", description: "Unrestricted access to the internet and any file on your computer", icon: <ShieldIcon className="size-4" /> },
]

/** "claude-fable-5-1" -> "Claude Fable 5.1" when the catalog has no entry. */
// Rich input: text and inline tokens. It grows with its content up to 200px,
// then scrolls; tokens are real elements sized like sent messages.
// `overflow-y: auto` alone makes the x axis scrollable too, and spaces that hang
// at a wrapped line's end overflow sideways. Clip that axis like a textarea does.
const EDITOR_CLASS = cn(
  "block max-h-[200px] w-full overflow-x-hidden overflow-y-auto break-words whitespace-pre-wrap outline-none selectable",
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
)

const DEFAULT_PLACEHOLDER = "Ask anything, @ to mention, $ skills, or / commands"

type ComposerMenuItem =
  | { id: string; type: "thread"; thread: Thread; snippet?: string | null }
  | { id: string; type: "note"; note: NoteSummary; snippet: string | null }
  | { id: string; type: "task"; task: TaskItem }
  | { id: string; type: "file"; path: string }
  | { id: string; type: "attachment"; attachment: Attachment }
  | { id: string; type: "command"; command: SlashCommand }
  | { id: string; type: "skill"; skill: SkillInfo }
  | { id: string; type: "plugin"; skill: SkillInfo }

function rankSkills(skills: readonly SkillInfo[], query: string, limit = 12, scope: "skill" | "plugin" = "skill"): SkillInfo[] {
  return skills
    .filter((skill) => skill.enabled && (skill.scope === "plugin") === (scope === "plugin"))
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
    case "plugin":
      return "Plugin"
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
    onSteer,
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
    hideInput,
    autoFocus,
    className,
    surfaceMode = "single",
    onDigit,
    sendLabel,
    onMentionsChange,
  } = props
  const [ownerStore] = useState(() => useStore)
  const [savedDraft] = useState(() => props.draftKey ? ownerStore.getState().composerDrafts[props.draftKey] : undefined)
  // The untouched prefill from `initialMentions`; it becomes a draft once edited.
  const [prefill] = useState(() => {
    if (savedDraft || !props.initialMentions?.length) return null
    const references: ComposerMentionReference[] = []
    for (const part of props.initialMentions) {
      const reference = createComposerMentionReference(part, references)
      if (!references.includes(reference)) references.push(reference)
    }
    return { text: `${references.map((reference) => reference.token).join(" ")} `, references }
  })
  const connected = useStore((s) => s.connection.state === "open")
  const projects = useStore((s) => s.projects)
  const threads = useStore((s) => s.threads)
  const disabled = disabledByParent || !connected
  const [text, setText] = useState(savedDraft?.text ?? prefill?.text ?? "")
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>(() => labelAttachments(savedDraft?.attachments ?? []))
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue")
  const steering = running && !!onSteer && promptMode === "steer"
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false)
  // Throttles the silent catalog refresh fired whenever the picker opens, so
  // rapid re-opens don't re-probe every agent CLI. Matches the daemon's cache window.
  const lastModelRefresh = useRef(0)
  const [changingModel, setChangingModel] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [fileResult, setFileResult] = useState<{ query: string; files: string[] }>({ query: "", files: [] })
  const [threadResult, setThreadResult] = useState<{ query: string; threads: { thread: Thread; snippet?: string | null }[] }>({ query: "", threads: [] })
  const [skillCatalog, setSkillCatalog] = useState<{ key: string; skills: SkillInfo[] }>({ key: "", skills: [] })
  const [menuSel, setMenuSel] = useState<{ sig: string; index: number }>({ sig: "", index: 0 })
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null)
  const [noteHits, setNoteHits] = useState<{ query: string; hits: ReadonlyMap<NoteId, string> }>({ query: "", hits: new Map() })
  // The chip picked for one `@` (keyed by its position); a new `@` starts on All.
  const [mentionChip, setMentionChip] = useState<{ key: string; filter: MentionFilter }>({ key: "", filter: "all" })
  const mentioned = useRef(new Set<string>(savedDraft?.mentions ?? []))
  const selectedSkills = useRef(new Map<string, SkillInfo>((savedDraft?.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill])))
  const selectedThreadReferences = useRef<ComposerThreadReference[]>(savedDraft?.threadReferences ?? [])
  const [initialMentionReferences] = useState<ComposerMentionReference[]>(() => (savedDraft as DraftMentionExtras | undefined)?.mentionReferences ?? prefill?.references ?? [])
  const selectedMentionReferences = useRef<ComposerMentionReference[]>(initialMentionReferences)
  // Render-safe snapshot of the two refs above for the highlight layer; refreshed
  // after every pick and send so painted tokens match what buildParts will send.
  const [tokenSources, setTokenSources] = useState(() => ({
    mentions: new Set<string>(savedDraft?.mentions ?? []),
    skills: [...(savedDraft?.skills ?? [])],
    threadReferences: [...(savedDraft?.threadReferences ?? [])],
    mentionReferences: [...initialMentionReferences],
  }))
  const syncTokenSources = () => setTokenSources({
    mentions: new Set(mentioned.current),
    skills: [...selectedSkills.current.values()],
    threadReferences: [...selectedThreadReferences.current],
    mentionReferences: [...selectedMentionReferences.current],
  })
  const editor = useRef<ComposerEditorHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuList = useRef<HTMLDivElement>(null)
  const menuListId = useId()
  const previewUrls = useRef(new Set<string>())

  useLayoutEffect(() => {
    const key = props.draftKey
    if (!key) return
    ownerStore.getState().set((state) => {
      const composerDrafts = { ...state.composerDrafts }
      if ((text || attachments.length) && !(prefill && text === prefill.text && !attachments.length)) {
        const draft: (typeof composerDrafts)[string] & DraftMentionExtras = {
          text, attachments: attachments.map(({ id, name, media_type, size, label }) => ({ id, name, media_type, size, label })),
          mentions: [...mentioned.current], skills: [...selectedSkills.current.values()],
          threadReferences: [...selectedThreadReferences.current],
          mentionReferences: [...selectedMentionReferences.current],
        }
        composerDrafts[key] = draft
      } else delete composerDrafts[key]
      return { composerDrafts }
    })
  }, [text, attachments, ownerStore, props.draftKey, prefill])

  useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    },
    [],
  )

  const setTextAndCaret = useCallback((next: string, pos?: number) => {
    setText(next)
    requestAnimationFrame(() => {
      const el = editor.current
      if (!el) return
      el.focus()
      el.setCaret(pos ?? next.length)
    })
  }, [])

  /** Remember a picked note or task so its token paints as a chip and sends as its part. */
  const rememberMention = (part: MentionPart): ComposerMentionReference => {
    const reference = createComposerMentionReference(part, selectedMentionReferences.current, selectedThreadReferences.current.map((item) => item.token))
    selectedMentionReferences.current = [...selectedMentionReferences.current.filter((item) => item.part.path !== part.path), reference]
    syncTokenSources()
    return reference
  }


  useEffect(() => {
    if (autoFocus) editor.current?.focus()
  }, [autoFocus])

  // ---- @ files, $ skills, and / commands ----

  // Chats without a project have no catalog; they still get `@Computer`.
  const computerUse = useStore((s) => s.settings?.computer_use?.enabled ?? false) && !!provider && provider.kind !== "codex"
  // Threads, notes and tasks need no project, so `@` always opens the picker.
  const mention = useMemo(() => mentionAtCaret(text, caret), [text, caret])
  // `@note:login` searches notes for "login"; `term` is what every search uses.
  const mentionScope = useMemo(() => (mention ? parseMentionQuery(mention.query) : null), [mention])
  const term = mentionScope ? mentionScope.term : null

  const slash = useMemo(() => {
    const before = text.slice(0, caret)
    const start = before.lastIndexOf("/")
    if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]!))) return null
    const token = before.slice(start + 1)
    if (/\s/.test(token)) return null
    const skillOnly = token.toLowerCase().startsWith("skill:")
    return { start, query: skillOnly ? token.slice(6) : token, skillOnly }
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
    if (term === null) return
    let live = true
    const id = setTimeout(() => {
      if (projectId) {
        void searchFiles(projectId, term, 12)
          .then((files) => live && setFileResult({ query: term, files }))
          .catch(() => live && setFileResult({ query: term, files: [] }))
      }
      if (!term) {
        setThreadResult({ query: "", threads: [] })
        setNoteHits({ query: "", hits: new Map() })
        return
      }
      void rpc().call("threads.search", { project_id: projectId ?? null, all_projects: true, query: term, limit: 12 })
        .then((result) => live && setThreadResult({ query: term, threads: result.threads }))
        .catch(() => live && setThreadResult({ query: term, threads: [] }))
      // Titles and previews match locally at once; the daemon adds body matches.
      Promise.resolve()
        .then(() => noteClient("env").call("notes.search", { query: term, limit: 8 }))
        .then((result) => live && setNoteHits({ query: term, hits: new Map(result.results.map((hit) => [hit.id, hit.snippet])) }))
        .catch(() => live && setNoteHits({ query: term, hits: new Map() }))
    }, 60)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [term, projectId])

  const skillCatalogKey = projectId && provider ? `${projectId}:${provider.kind}` : ""
  const needsSkills = !!skill || !!slash || !!mention
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

  const skills = useMemo<SkillInfo[]>(
    () => (!projectId ? (computerUse ? [{ ...COMPUTER_MENTION_SKILL }] : []) : skillCatalog.key === skillCatalogKey ? skillCatalog.skills : []),
    [skillCatalog, skillCatalogKey, projectId, computerUse],
  )
  const files = useMemo(() => (fileResult.query === term ? fileResult.files : []), [fileResult, term])
  const currentThreadId = props.draftKey?.startsWith("thread:") ? props.draftKey.slice("thread:".length) : null
  const threadHits = useMemo(
    () => term === ""
      ? Object.values(threads)
          .filter((thread) => thread.id !== currentThreadId && thread.status !== "archived" && !isChildThread(thread))
          .sort((left, right) => Number(right.project_id === projectId) - Number(left.project_id === projectId) || Date.parse(right.updated_at) - Date.parse(left.updated_at))
          .slice(0, 12)
          .map((thread) => ({ thread }))
      : threadResult.query === term
        ? threadResult.threads.filter((hit) => hit.thread.id !== currentThreadId)
        : [],
    [currentThreadId, term, projectId, threadResult, threads],
  )
  // Notes and tasks are read only while the @ picker is up, so their changes never
  // re-render an idle composer.
  const noteFeed = useNotes((s) => (mention ? s.env.notes : NO_NOTES))
  const taskFeed = useTasks((s) => (mention ? s.tasks : NO_TASKS))
  const mentionNotes = useMemo(() => {
    if (term === null) return { any: false, hits: [] }
    // Shared Global notes live on This Mac; this environment's daemon cannot read them into a prompt.
    const shared = isHomeShared()
    const list = Object.values(noteFeed).filter((note) => !note.deleted_at && !(shared && note.scope === "global"))
    return { any: list.length > 0, hits: rankMentionNotes(list, term, noteHits.query === term ? noteHits.hits : null, projectId) }
  }, [noteFeed, noteHits, projectId, term])
  const mentionTasks = useMemo(() => {
    if (term === null) return { any: false, hits: [] }
    const list = Object.values(taskFeed)
    return { any: list.length > 0, hits: rankMentionTasks(list, term, projectId, keyMatchesQuery) }
  }, [taskFeed, projectId, term])
  const attachmentReferences = useMemo<AttachmentReference[]>(
    () => attachments.map((a) => ({ token: `@${a.label}`, part: attachmentPart(a) })),
    [attachments],
  )

  const mentionKey = mention ? `@${mention.start}` : null
  const mentionFilter: MentionFilter = mentionScope?.kind ?? (mentionChip.key === mentionKey ? mentionChip.filter : "all")
  const anyThread = !!mention && Object.keys(threads).length > (currentThreadId ? 1 : 0)
  const anyPlugin = skills.some((item) => item.enabled && item.scope === "plugin")
  // Chips for kinds that can have results; none when there is only one kind to show.
  const mentionChips = useMemo<MentionFilter[]>(() => {
    if (!mention) return []
    const available: Record<MentionKind, boolean> = { thread: anyThread, note: mentionNotes.any, task: mentionTasks.any, file: !!projectId, plugin: anyPlugin }
    const kinds = MENTION_KINDS.filter((kind) => available[kind] || kind === mentionFilter)
    return kinds.length > 1 || mentionFilter !== "all" ? ["all", ...kinds] : []
  }, [anyPlugin, anyThread, mention, mentionFilter, mentionNotes.any, mentionTasks.any, projectId])

  const menuItems = useMemo<ComposerMenuItem[]>(() => {
    if (mention && term !== null) {
      const byKind: Record<MentionKind, ComposerMenuItem[]> = {
        thread: threadHits.map((hit) => ({ id: `thread:${hit.thread.id}`, type: "thread" as const, ...hit })),
        note: mentionNotes.hits.map(({ note, snippet }) => ({ id: `note:${note.id}`, type: "note" as const, note, snippet })),
        task: mentionTasks.hits.map((task) => ({ id: `task:${task.id}`, type: "task" as const, task })),
        file: files.map((path) => ({ id: `file:${path}`, type: "file" as const, path })),
        plugin: rankSkills(skills, term, 12, "plugin").map((item) => ({ id: `plugin:${item.path}`, type: "plugin" as const, skill: item })),
      }
      if (mentionFilter !== "all") return byKind[mentionFilter]
      const attachmentItems = attachments
        .filter((a) => fuzzyScore(a.label, term) != null || fuzzyScore(a.name, term) != null)
        .map((attachment) => ({ id: `attachment:${attachment.id}`, type: "attachment" as const, attachment }))
      // A few of each kind; when only one kind matches, all of it.
      const filled = MENTION_KINDS.filter((kind) => byKind[kind].length > 0).length + (attachmentItems.length > 0 ? 1 : 0)
      const cap = filled > 1 ? MENTION_ALL_PER_KIND : Infinity
      return [...attachmentItems, ...MENTION_KINDS.flatMap((kind) => byKind[kind].slice(0, cap))]
    }
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
  }, [attachments, commands, files, mention, mentionFilter, mentionNotes.hits, mentionTasks.hits, skill, skills, slash, term, threadHits])
  const menuKey = mentionKey ?? (skill ? `$${skill.start}` : slash ? `/${slash.start}` : null)
  const menuOpen = !!menuKey && menuDismissed !== menuKey
  const menuSignature = `${menuKey}:${mention ? mentionFilter : ""}:${menuItems.map((item) => item.id).join("|")}`
  const menuIndex = menuSel.sig === menuSignature ? menuSel.index : 0
  const setMenuIndex = (f: number | ((i: number) => number)) => setMenuSel({ sig: menuSignature, index: typeof f === "function" ? f(menuIndex) : f })

  useLayoutEffect(() => {
    if (!menuOpen) return
    menuList.current?.querySelector<HTMLElement>(`[data-menu-index="${menuIndex}"]`)?.scrollIntoView({ block: "nearest" })
  }, [menuIndex, menuOpen, menuSignature])

  /** Show one kind (or All). A typed `note:` prefix gives way to the chip. */
  const selectMentionFilter = (next: MentionFilter) => {
    if (!mention || !mentionScope) return
    setMentionChip({ key: `@${mention.start}`, filter: next })
    if (mentionScope.kind && mentionScope.kind !== next) {
      const from = mention.start + 1
      setTextAndCaret(`${text.slice(0, from)}${text.slice(from + mentionScope.prefixLength)}`, Math.max(from, caret - mentionScope.prefixLength))
    }
  }

  const pickMention = (path: string) => {
    if (!mention) return
    mentioned.current.add(path)
    syncTokenSources()
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`
    setTextAndCaret(next, mention.start + path.length + 2)
  }
  const pickAttachment = (attachment: Attachment) => {
    if (!mention) return
    const token = `@${attachment.label} `
    setTextAndCaret(`${text.slice(0, mention.start)}${token}${text.slice(caret)}`, mention.start + token.length)
  }
  const pickThread = (thread: Thread) => {
    if (!mention) return
    const projectName = isFreeChatProject(thread.project_id) ? "Free chat" : projects[thread.project_id]?.name
    const reference = createComposerThreadReference(thread, selectedThreadReferences.current, projectName)
    selectedThreadReferences.current = [...selectedThreadReferences.current.filter((item) => item.part.thread_id !== thread.id), reference]
    syncTokenSources()
    const next = `${text.slice(0, mention.start)}${reference.token} ${text.slice(caret)}`
    setTextAndCaret(next, mention.start + reference.token.length + 1)
  }
  const pickKybernMention = (part: MentionPart) => {
    if (!mention) return
    const reference = rememberMention(part)
    const next = `${text.slice(0, mention.start)}${reference.token} ${text.slice(caret)}`
    setTextAndCaret(next, mention.start + reference.token.length + 1)
  }
  const pickCommand = (cmd: SlashCommand) => {
    if (!slash) return
    if (cmd.insert) {
      const invocation = `/${cmd.invocation ?? cmd.name} `
      setTextAndCaret(`${text.slice(0, slash.start)}${invocation}${text.slice(caret)}`, slash.start + invocation.length)
      return
    }
    setTextAndCaret(`${text.slice(0, slash.start)}${text.slice(caret)}`, slash.start)
    if (cmd.name === "attach") fileInput.current?.click()
    else cmd.run()
  }
  const pickPlugin = (item: SkillInfo) => {
    if (!mention) return
    selectedSkills.current.set(item.path, item)
    syncTokenSources()
    const token = `@${item.display_name ?? item.name} `
    const next = `${text.slice(0, mention.start)}${token}${text.slice(caret)}`
    setTextAndCaret(next, mention.start + token.length)
  }
  const pickSkill = (item: SkillInfo) => {
    selectedSkills.current.set(item.name.toLowerCase(), item)
    syncTokenSources()
    const trigger = skill ?? (slash)
    if (!trigger) return
    const token = `$${item.name} `
    const next = `${text.slice(0, trigger.start)}${token}${text.slice(caret)}`
    setTextAndCaret(next, trigger.start + token.length)
  }
  const pick = (i: number) => {
    const item = menuItems[i]
    if (!item) return
    if (item.type === "thread") pickThread(item.thread)
    else if (item.type === "note") pickKybernMention(noteMentionPart({ id: item.note.id, title: noteTitle(item.note) }))
    else if (item.type === "task") pickKybernMention(taskMentionPart(item.task))
    else if (item.type === "file") pickMention(item.path)
    else if (item.type === "attachment") pickAttachment(item.attachment)
    else if (item.type === "command") pickCommand(item.command)
    else if (item.type === "plugin") pickPlugin(item.skill)
    else pickSkill(item.skill)
  }

  // ---- sending ----

  const canSend = !disabled && !props.sendDisabled && !sending && uploading === 0 && (text.trim().length > 0 || attachments.length > 0)

  // Tokens the editor shows: the same ones buildParts will send.
  const segments = useMemo(
    () => structuredSegments(text, tokenSources.mentions, [...skills, ...tokenSources.skills], tokenSources.threadReferences, attachmentReferences, tokenSources.mentionReferences),
    [text, skills, tokenSources, attachmentReferences],
  )

  const editorSegments = useMemo<EditorSegment[]>(
    () =>
      segments.map((segment) =>
        segment.kind === "token"
          ? {
              kind: "token",
              text: segment.text,
              token:
                segment.part.type === "thread_reference" ? "thread"
                : segment.part.type === "skill" ? "skill"
                : segment.part.type === "mention" ? mentionTokenKind(segment.part.path)
                : segment.part.type === "attachment" ? "attachment"
                : "file",
            }
          : { kind: "text", text: segment.text },
      ),
    [segments],
  )

  const buildParts = (): ContentPart[] => {
    const skillItems = [...skills, ...selectedSkills.current.values()]
    const parts = buildStructuredTextParts(text, mentioned.current, skillItems, selectedThreadReferences.current, attachmentReferences, selectedMentionReferences.current)
    // Attachments the prompt never mentions keep their old place at the end.
    const placed = new Set(parts.flatMap((part) => (part.type === "attachment" ? [part.asset_id] : [])))
    for (const a of attachments) if (!placed.has(a.id)) parts.push(attachmentPart(a))
    return parts
  }

  const submit = async (delivery: "queue" | "steer" = promptMode) => {
    if (!canSend) return
    const targetStatus = provider ? providers.find((candidate) => candidate.kind === provider.kind) : undefined
    const targetLegacyCursor = provider?.kind === "cursor" && !!props.providerSessionId && !props.providerSessionId.startsWith("cursor-sdk:")
    const unsupportedMode = provider?.kind === "cursor" && !targetLegacyCursor
      ? mode !== "auto" && mode !== "full-access"
      : provider?.kind === "pi" ? mode === "auto" : !!targetStatus && !targetStatus.supported_permission_modes.includes(mode)
    if (unsupportedMode) {
      toast.error("Choose permissions", { description: "Choose a supported permission mode for the selected agent before sending." })
      return
    }
    setSending(true)
    try {
      await (running && delivery === "steer" && onSteer ? onSteer : onSend)({ parts: buildParts() })
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
      selectedThreadReferences.current = []
      selectedMentionReferences.current = []
      syncTokenSources()
      editor.current?.focus()
    } catch (e) {
      if (!(e instanceof SendCancelled)) toast.error("Unable to send", { description: errorText(e) })
    } finally {
      setSending(false)
    }
  }

  // Tell the parent which chips the text still holds, as they are added and removed.
  const reportMentions = useRef(onMentionsChange)
  useEffect(() => {
    reportMentions.current = onMentionsChange
  })
  const shownMentions = tokenSources.mentionReferences.filter((item) => hasToken(text, item.token)).map((item) => item.part)
  const shownMentionKey = shownMentions.map((part) => part.path).join("\n")
  useEffect(() => {
    reportMentions.current?.(shownMentions)
    // `shownMentionKey` stands for `shownMentions`: a new array with the same chips is not news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownMentionKey])

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    setText: (t) => setTextAndCaret(t),
    isEmpty: () => text.trim().length === 0 && attachments.length === 0,
    insertMention: (part) => {
      const shown = selectedMentionReferences.current.find((item) => item.part.path === part.path)
      if (shown && hasToken(text, shown.token)) return
      const reference = rememberMention(part)
      const focused = !!editor.current?.element && document.activeElement === editor.current.element
      const at = focused ? Math.min(caret, text.length) : text.length
      const before = text.slice(0, at)
      const insert = `${before && !/\s$/.test(before) ? " " : ""}${reference.token} `
      setTextAndCaret(`${before}${insert}${text.slice(at)}`, at + insert.length)
    },
    removeMention: (path) => {
      const tokens = selectedMentionReferences.current.filter((item) => item.part.path === path).map((item) => item.token)
      if (!tokens.length) return
      selectedMentionReferences.current = selectedMentionReferences.current.filter((item) => item.part.path !== path)
      syncTokenSources()
      let next = text
      for (const token of tokens) next = next.replace(tokenPattern(token, "g"), (_match, lead: string) => lead)
      if (next !== text) setText(next)
    },
    mentions: () => selectedMentionReferences.current.filter((item) => hasToken(text, item.token)).map((item) => item.part),
    submit: () => void submit(),
  }))

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
        setAttachments((a) => [...a, { ...info, preview, label: nextAttachmentLabel(info.media_type, a.map((item) => item.label)) }])
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    const steerShortcut = running && (isMac ? e.metaKey : e.ctrlKey)
    // ←/→ switch the @ picker's chips until a term is typed; after that, and with a
    // modifier, they move or select text as usual.
    if (menuOpen && mention && mentionChips.length > 1 && mentionArrowsSwitchChips(mention.query) && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      const at = Math.max(0, mentionChips.indexOf(mentionFilter))
      selectMentionFilter(mentionChips[(at + (e.key === "ArrowRight" ? 1 : -1) + mentionChips.length) % mentionChips.length]!)
      return
    }
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
      if ((e.key === "Enter" && !e.shiftKey && !steerShortcut) || e.key === "Tab") {
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
      void submit(running ? (steerShortcut ? "steer" : "queue") : promptMode)
    }
  }


  // ---- model picker ----

  const status = provider ? providers.find((p) => p.kind === provider.kind) : undefined
  const models = status?.models ?? []
  const current = model ? findModel(models, model) : models.find((m) => m.is_default)
  const modelLabel = current?.display_name ?? (model || null)
  const modelQualifierLabel = modelQualifier(models, current)
  const effortLabel = effort ?? current?.default_effort ?? null
  const canPickModel = !!onModelChange
  const canReloadModels = !!onModelChange && !!status?.available && status.supports_model_switch
  const canPickProvider = !!onProviderChange
  const legacyCursor = provider?.kind === "cursor" && !!props.providerSessionId && !props.providerSessionId.startsWith("cursor-sdk:")
  const modes = provider?.kind === "cursor" && !legacyCursor
    ? MODES.filter((m) => m.mode === "auto" || m.mode === "full-access").map((m) => m.mode === "auto"
      ? { ...m, label: "Auto-review", description: "Run in Cursor’s sandbox with automatic review; no approval prompts" }
      : { ...m, description: "Disable Cursor’s sandbox and automatic review" })
    : MODES
  const supportedMode = modes.find((candidate) => candidate.mode === mode && (legacyCursor || !status || status.supported_permission_modes.includes(mode)))
  const effectiveMode = MODES.find((candidate) => candidate.mode === mode)!
  const modeInfo = supportedMode ?? { ...effectiveMode, label: "Choose permissions", description: `${effectiveMode.label} is not supported by the selected agent` }
  const wantsMention = (kind: MentionKind) => mentionFilter === "all" || mentionFilter === kind
  const menuLoading = mention && term !== null
    ? (wantsMention("file") && !!projectId && fileResult.query !== term) || (wantsMention("thread") && !!term && threadResult.query !== term)
    : (!!skill || !!slash) && skillCatalog.key !== skillCatalogKey
  const menuEmptyText = mention && term !== null
    ? menuLoading ? "Searching…" : mentionEmptyText(mentionFilter, term, !!projectId)
    : menuLoading
      ? "Loading agent skills…"
      : skill
        ? "No matching skills"
        : "No matching commands or skills"

  async function changeModel(nextModel: string | undefined, nextEffort: string | undefined) {
    if (changingModel) return false
    setChangingModel(true)
    try {
      await onModelChange?.(nextModel, nextEffort)
      return true
    } catch (error) {
      toast.error("Unable to change model", { description: errorText(error) })
      return false
    } finally {
      setChangingModel(false)
    }
  }

  async function changeProvider(nextProvider: ProviderInstance, choice?: { model?: string; effort?: string }) {
    if (changingModel) return false
    setChangingModel(true)
    try {
      await onProviderChange?.(nextProvider, choice)
      return true
    } catch (error) {
      toast.error("Unable to change harness", { description: errorText(error) })
      return false
    } finally {
      setChangingModel(false)
    }
  }

  // Re-probe the daemon for the current agent's catalog. `silent` is the
  // background refresh fired on picker open — it never toasts; the explicit
  // "Reload models" action reports an empty result or a failure.
  const refreshModelCatalog = async (silent: boolean) => {
    if (!provider || modelCatalogLoading) return
    lastModelRefresh.current = Date.now()
    setModelCatalogLoading(true)
    try {
      const refreshed = await refreshProviders(projectId)
      if (silent) return
      const count = refreshed.find((item) => item.kind === provider.kind)?.models?.length ?? 0
      if (count === 0) {
        const description = provider.kind === "omp"
          ? "Run omp models ls --json and check the provider login, then reload models."
          : "Check the provider login, then reload models."
        toast.error("Models are still unavailable", { description })
      }
    } catch (error) {
      if (!silent) toast.error("Unable to reload models", { description: errorText(error) })
    } finally {
      setModelCatalogLoading(false)
    }
  }
  const reloadModels = () => refreshModelCatalog(false)

  return (
    <ComposerColumnFrame className={cn(className, surfaceMode === "split" && "split-chat-composer")}>
      <div className="composer-above">{above}</div>
      <div
        className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, menuOpen && "overflow-visible", hideInput && "hidden")}
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
                <div className={COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME}>
                  {mention && mentionChips.length > 1 && (
                    <ComposerMentionChips
                      chips={mentionChips.map((id) => ({ id, label: MENTION_FILTER_LABEL[id] }))}
                      active={mentionFilter}
                      onSelect={selectMentionFilter}
                      controls={menuListId}
                    />
                  )}
                  <div
                    ref={menuList}
                    id={menuListId}
                    role="listbox"
                    aria-label={mention ? `Mention ${mentionFilter === "all" ? "anything" : MENTION_FILTER_LABEL[mentionFilter].toLowerCase()}` : slash ? "Commands and skills" : "Skills"}
                    className="max-h-[min(22rem,45vh)] scroll-py-1 overflow-y-auto overscroll-contain p-1.5"
                  >
                    {menuItems.length === 0 ? (
                      <p className="px-2.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground/60">{menuEmptyText}</p>
                    ) : (
                      menuItems.map((item, i) => {
                        const active = i === menuIndex
                        const previous = menuItems[i - 1]
                        const sectionOf = (entry: ComposerMenuItem | undefined) =>
                          !entry ? null : entry.type === "thread" ? "Threads" : entry.type === "note" ? "Notes" : entry.type === "task" ? "Tasks" : entry.type === "attachment" ? "Attachments" : entry.type === "file" ? "Files" : entry.type === "command" ? "Commands" : entry.type === "plugin" ? "Plugins" : "Skills"
                        const section = sectionOf(item)
                        const previousSection = sectionOf(previous)
                        const title =
                          item.type === "thread"
                            ? item.thread.title || "Untitled thread"
                            : item.type === "note"
                            ? noteTitle(item.note)
                            : item.type === "task"
                            ? item.task.title.trim() || "Untitled task"
                            : item.type === "attachment"
                            ? `@${item.attachment.label}`
                            : item.type === "file"
                            ? basename(item.path)
                            : item.type === "command"
                              ? titleCase(item.command.name)
                              : item.type === "plugin"
                                ? item.skill.display_name ?? titleCase(item.skill.name)
                                : item.skill.display_name ?? titleCase(item.skill.name)
                        const description = item.type === "thread" ? item.snippet : item.type === "note" ? item.snippet ?? item.note.preview : item.type === "attachment" ? item.attachment.name : item.type === "command" ? item.command.hint : item.type === "skill" || item.type === "plugin" ? item.skill.description : null
                        return (
                          <Fragment key={item.id}>
                            {(!mention || mentionFilter === "all") && section !== previousSection && (
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
                              <span className={cn("flex size-4 shrink-0 items-center justify-center", item.type !== "task" && "[&_[stroke]]:[stroke-width:2]", active ? "text-foreground" : "text-foreground/85")}>
                                {item.type === "thread" ? (
                                  <MessageCircleIcon className="size-4" />
                                ) : item.type === "note" ? (
                                  <NoteIcon className="size-4" />
                                ) : item.type === "task" ? (
                                  <TaskStatusGlyph status={item.task.status} size={14} title={STATUS_LABEL[item.task.status]} />
                                ) : item.type === "attachment" ? (
                                  <FileEntryIcon pathValue={item.attachment.name} kind="file" mimeType={item.attachment.media_type} className="size-4" />
                                ) : item.type === "file" ? (
                                  <FileEntryIcon pathValue={item.path} kind="file" className="size-4" />
                                ) : item.type === "skill" ? (
                                  <SkillCubeIcon className="size-4" />
                                ) : item.type === "plugin" ? (
                                  item.skill.path === COMPUTER_MENTION_PATH ? <DeviceLaptopIcon className="size-4" /> : <PluginIcon className="size-4" />
                                ) : (
                                  item.command.icon ?? <TerminalIcon className="size-4" />
                                )}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                {/* One line, Codex-style: the name in crisp full-strength ink at a
                                    regular weight, its description inline in muted ink. Hierarchy is
                                    carried by colour, not by a heavier title weight. */}
                                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                                  {item.type === "task" && (
                                    <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/60">{item.task.key}</span>
                                  )}
                                  <span className="max-w-[60%] shrink-0 truncate text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground">{title}</span>
                                  {description && description !== title && (
                                    <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">{description}</span>
                                  )}
                                </span>
                                {item.type === "thread" ? (
                                  <span className="max-w-[38%] shrink-0 truncate text-end text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">{isFreeChatProject(item.thread.project_id) ? "Free chat" : projects[item.thread.project_id]?.name ?? "Project"}</span>
                                ) : item.type === "note" ? (
                                  <span className="flex max-w-[38%] shrink-0 items-baseline gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">
                                    {item.note.checklist.total > 0 && (
                                      <span className="shrink-0 tabular-nums" title={`${item.note.checklist.done} of ${item.note.checklist.total} done`}>{item.note.checklist.done}/{item.note.checklist.total}</span>
                                    )}
                                    <span className="min-w-0 truncate">{noteScopeLabel(item.note, projects, threads)}</span>
                                  </span>
                                ) : item.type === "task" ? (
                                  <span className="flex max-w-[38%] shrink-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">
                                    {item.task.priority !== 0 && (
                                      <span className="flex shrink-0 text-muted-foreground/70" title={PRIORITY_LABEL[item.task.priority]}>
                                        <PriorityGlyph priority={item.task.priority} size={12} />
                                        <span className="sr-only">{PRIORITY_LABEL[item.task.priority]}</span>
                                      </span>
                                    )}
                                    <span className="min-w-0 truncate">{item.task.scope === "global" || !item.task.project_id ? "Global" : projects[item.task.project_id]?.name ?? "Project"}</span>
                                  </span>
                                ) : item.type === "file" ? (
                                  <span className="max-w-[38%] shrink-0 truncate text-end text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/45">{parentPath(item.path)}</span>
                                ) : item.type === "attachment" ? null : item.type === "command" ? (
                                  <span className="shrink-0 text-end font-chat-code text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/40">/{item.command.name}</span>
                                ) : (
                                  <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/55">
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
                  a.media_type.startsWith("image/") ? (
                    <div key={a.id} className="t-pop group relative size-16 shrink-0 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)]">
                        <ComposerImageAttachment id={a.id} name={a.name} preview={a.preview} />
                      <span aria-hidden className="pointer-events-none absolute bottom-1 left-1 rounded-md bg-black/55 px-1 font-system-ui text-[10px] leading-4 font-medium text-white">@{a.label}</span>
                      <RemoveButton name={a.name} onClick={() => removeAttachment(a)} />
                    </div>
                  ) : (
                    <span key={a.id} className="t-pop group relative inline-flex h-14 w-60 max-w-full items-center gap-2.5 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--composer-surface)] py-2 pr-8 pl-2 shadow-sm">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
                        <FileEntryIcon pathValue={a.name} kind="file" mimeType={a.media_type} className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
                        <span className="truncate text-[13px] font-medium text-foreground">{a.name}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><span>@{a.label}</span><span className="uppercase">{a.name.split(".").pop()}</span></span>
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

            <div
              data-composer-editor-frame
              className={cn("relative", COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME, COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME)}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return
                event.preventDefault()
                editor.current?.focus({ preventScroll: true })
              }}
            >
            <ComposerEditor
              ref={editor}
              data-testid="composer-editor"
              value={text}
              segments={editorSegments}
              placeholder={placeholder}
              disabled={disabled}
              className={cn(EDITOR_CLASS, disabled && "opacity-60")}
              onChange={(next, position) => {
                setText(next)
                setCaret(position)
                setMenuSel({ sig: "", index: 0 })
                setMenuDismissed(null)
              }}
              onCaret={setCaret}
              onKeyDown={onKeyDown}
              onPasteFiles={(e) => {
                const pasted = clipboardFiles(e.clipboardData)
                if (!pasted.length) return false
                e.preventDefault()
                void addFiles(pasted)
                return true
              }}
            />
            </div>
          </div>

          {!hideFooter && (
            <div
              data-chat-composer-footer
              className={cn(
                "@container",
                COMPOSER_FOOTER_ROW_CLASS_NAME,
                "min-w-0 flex-nowrap gap-1.5 sm:gap-1",
              )}
            >
              <div
                data-chat-composer-leading
                className={cn(
                  "flex min-w-0 items-center gap-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  "shrink-0 overflow-visible",
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
                        {modes.map((m) => {
                          const supported = legacyCursor || !status || status.supported_permission_modes.includes(m.mode)
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
                              <span className="flex w-full min-w-0 flex-1 items-center gap-3">
                                <span className="flex shrink-0 items-center justify-center [&_svg]:size-[18px] [&_svg]:shrink-0">{m.icon}</span>
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span className="font-medium leading-tight">{m.label}</span>
                                  <span className={cn("runtime-mode-menu-description text-xs font-normal leading-snug", m.mode === "full-access" ? "text-current" : "text-muted-foreground")}>{m.description}</span>
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
                className="flex min-w-0 flex-1 items-center justify-end gap-1"
              >
                {props.promptCache && (
                  <PromptCacheIndicator
                    cacheWindow={props.promptCache.window}
                    lastActivityAt={props.promptCache.lastActivityAt}
                    running={running}
                  />
                )}
                {props.accountControl}
                {props.showProviderUsage && <ProviderUsageIndicator usage={props.providerUsage} provider={provider?.kind} />}
                {provider && (
                  <ModelPicker
                    provider={provider}
                    providers={providers}
                    model={model}
                    effort={effort}
                    canPickModel={canPickModel}
                    canPickProvider={canPickProvider}
                    canReload={canReloadModels}
                    loading={modelCatalogLoading}
                    busy={changingModel}
                    onOpenChange={(open) => {
                      if (!open || !canReloadModels) return
                      // Self-heal against a stale catalog (e.g. models shipped mid-session)
                      // without re-probing on every open.
                      if (Date.now() - lastModelRefresh.current < 60_000) return
                      void refreshModelCatalog(true)
                    }}
                    onModelChange={changeModel}
                    onEffortChange={(next) => changeModel(current?.id ?? model ?? undefined, next)}
                    onProviderChange={changeProvider}
                    onReload={() => void reloadModels()}
                    onSetUpProvider={(kind) => useStore.getState().set({ settingsOpen: true, settingsTab: "agents", settingsFocus: `provider:${kind}` })}
                    trigger={
                      <Button
                        size="sm"
                        variant="chrome"
                        disabled={!canPickModel && !canReloadModels && !canPickProvider}
                        aria-label="Change model and reasoning"
                        title={`${modelLabel ?? PROVIDER_LABEL[provider.kind]}${modelQualifierLabel ? ` from ${modelQualifierLabel}` : ""}${effortLabel ? `, ${formatEffort(effortLabel)} effort` : ""}`}
                        className={cn(
                          COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
                          "disabled:opacity-100",
                          COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                          COMPOSER_FOOTER_PICKER_TEXT_SIZE_CLASS_NAME,
                          "max-w-full !shrink overflow-hidden px-2 sm:px-2",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <ProviderMark kind={provider.kind} size={14} className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100" />
                          <span className={cn(
                            "min-w-0 truncate leading-none text-[var(--color-text-foreground)]",
                            "[text-box-trim:trim-both] [text-box-edge:cap_alphabetic]",
                            "@max-[360px]:hidden",
                          )}>{modelLabel ?? PROVIDER_LABEL[provider.kind]}</span>
                          {modelQualifierLabel && (
                            <span
                              className={cn(
                                "shrink-0 leading-none",
                                "[text-box-trim:trim-both] [text-box-edge:cap_alphabetic]",
                                COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
                                "@max-[480px]:hidden",
                              )}
                            >
                              {modelQualifierLabel}
                            </span>
                          )}
                          {modelLabel && effortLabel && (
                            <span
                              className={cn(
                                "shrink-0 leading-none",
                                "[text-box-trim:trim-both] [text-box-edge:cap_alphabetic]",
                                COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
                                "@max-[620px]:hidden",
                              )}
                            >
                              {formatEffort(effortLabel)}
                            </span>
                          )}
                          {(canPickModel || canReloadModels || canPickProvider) && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
                        </span>
                      </Button>
                    }
                  />
                )}

                {running && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="subtle"
                      size="chip"
                      className={cn(
                        "@max-[360px]:gap-0 @max-[360px]:px-1.5",
                      )}
                      aria-label={sending ? "Sending follow-up" : steering ? "Steer now" : "Queue follow-up"}
                      disabled={!canSend}
                      title={steering ? `${mod}+Enter to steer` : "Enter to queue"}
                      onClick={() => void submit()}
                    >
                      {sending ? (
                        <Spinner size={12} className={cn("hidden", "@max-[360px]:inline-flex")} />
                      ) : (
                        <ClockIcon className={cn("hidden size-3.5 shrink-0", "@max-[360px]:inline-flex")} aria-hidden />
                      )}
                      <span className={cn("@max-[360px]:sr-only")}>
                        {sending ? "Sending…" : steering ? "Steer now" : "Queue"}
                      </span>
                    </Button>
                    {onSteer && <Menu>
                      <MenuTrigger render={<Button variant="chrome" size="icon-xs" aria-label="Choose prompt delivery" disabled={sending} />}>
                        <ChevronDownIcon className="size-3" />
                      </MenuTrigger>
                      <ComposerPickerMenuPopup align="end" side="top" className="w-60">
                        <MenuGroup>
                          <MenuItem onClick={() => setPromptMode("queue")}>
                            <div><div>Queue follow-up{!steering ? " ✓" : ""}</div><div className="text-xs text-muted-foreground">Send after the current work finishes · Enter</div></div>
                          </MenuItem>
                          <MenuItem onClick={() => setPromptMode("steer")}>
                            <div><div>Steer now{steering ? " ✓" : ""}</div><div className="text-xs text-muted-foreground">Guide the current turn immediately · {mod}+Enter</div></div>
                          </MenuItem>
                        </MenuGroup>
                      </ComposerPickerMenuPopup>
                    </Menu>}
                  </div>
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
                    <TooltipPopup side="top">Stop generation</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="prominent"
                          size="icon-xs"
                          className={cn(COMPOSER_FOOTER_SEND_BUTTON_CLASS_NAME, surfaceMode === "split" && "!size-7 sm:!size-7", sendLabel && "tk-send-pill")}
                          aria-label={sending ? "Sending" : sendLabel ?? "Send message"}
                          disabled={!canSend}
                          onClick={() => void submit()}
                        />
                      }
                    >
                      {sendLabel ? (
                        <span className="whitespace-nowrap">{sendLabel}</span>
                      ) : (
                        <IconSwap
                          className="size-full"
                          active={sending ? "b" : "a"}
                          a={<ComposerSendArrowIcon className={COMPOSER_FOOTER_SEND_GLYPH_CLASS_NAME} />}
                          b={
                            <svg width={12} height={12} viewBox="0 0 14 14" className="animate-spin" aria-hidden>
                              <circle cx={7} cy={7} r={5.5} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeDasharray="20 12" fill="none" />
                            </svg>
                          }
                        />
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

function mentionEmptyText(filter: MentionFilter, term: string, hasProject: boolean): string {
  const query = term.trim()
  switch (filter) {
    case "all":
      return query ? `No results for “${query}”` : "Type to search threads, notes, tasks, and files"
    case "thread":
      return query ? "No matching threads" : "No other threads yet"
    case "note":
      return query ? "No matching notes" : "No notes yet"
    case "task":
      return query ? "No matching tasks" : "No tasks yet"
    case "file":
      return !hasProject ? "Open a project chat to mention its files" : query ? "No matching files" : "No files in this project"
    case "plugin":
      return query ? "No matching plugins" : "No plugins for this agent"
  }
}

/** A token standing alone in the text, with the one space it was inserted with. */
function tokenPattern(token: string, flags = ""): RegExp {
  return new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,.;:!?]|$) ?`, flags)
}

const hasToken = (text: string, token: string) => tokenPattern(token).test(text)

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/(^|[\s:])(\w)/g, (_m, sep: string, c: string) => `${sep}${c.toUpperCase()}`)
}

function parentPath(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

/** Empty-landing controls tray: stacked flush above the input. */
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
