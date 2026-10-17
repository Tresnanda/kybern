import { onEnvironmentChange } from '../shell/environment.ts'
import { useNotes, refreshNotes } from '../notes/store.ts'
import { useTasks, refreshTasks } from '../tasks/store.ts'
// The composer's @ mention, / command and $ skill completions
// (`views/Composer.tsx:436-682`, list styles `COMPOSER_COMMAND_MENU_*`): one
// opaque list floating 8px above the card at its full width, rows at 36px
// with a 16px icon, the title in full ink and the description muted on one
// line, section labels between kinds. ↑/↓ move, Enter or Tab pick, Escape
// dismisses that trigger. Native key interception handles key-down and repeat;
// ⌃N/⌃P remain additional shortcuts.
//
// Completion uses the native UTF-16 selection and one undoable edit.
import { FloatingLayer } from '@gpuix/react/floating'
import { inlineTokenLabel, mentionTokenKind } from '@/lib/inlineTokenLabel'
import { useEffect, useMemo, useState } from 'react'
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
} from '../../../desktop/src/views/composerMentions.ts'
import { noteScopeLabel, noteTitle } from '@/state/notesModel'
import { keyMatchesQuery, PRIORITY_LABEL, STATUS_LABEL } from '@/state/tasksModel'
import { COMPUTER_MENTION_PATH, noteMentionPart, taskMentionPart } from '../../../../packages/kybern-client/src/userInput.ts'
import { sharesHome } from '../notes/home.ts'
import { MentionChips } from './MentionChips.tsx'
import { getFileIconName } from '../../../desktop/src/lib/kit/fileIcons.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { PriorityGlyph, StatusGlyph } from '../tasks/Glyphs.tsx'
import { FONT_MONO } from '../theme.ts'
import {
  buildStructuredTextParts,
  createComposerMentionReference,
  type ComposerMentionReference,
  convertTypedSlashSkills,
  type AttachmentReference,
} from '../../../../packages/kybern-client/src/composerTokens.ts'
import { createComposerThreadReference, type ComposerThreadReference } from '../../../../packages/kybern-client/src/threadReferences.ts'
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { isFreeChatProject, type ContentPart, type NoteId, type NoteSummary, type ProjectId, type ProviderKind, type SkillInfo, type TaskItem, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { G } from './glyphs.ts'
import { muted, PICKER_RADIUS, popoverStyle } from './Menu.tsx'

export interface SlashCommand {
  name: string
  hint: string
  icon: string
  run: () => void
}

type Item =
  | { id: string; type: 'note'; note: NoteSummary; snippet: string | null }
  | { id: string; type: 'task'; task: TaskItem }
  | { id: string; type: 'thread'; thread: Thread; snippet?: string | null }
  | { id: string; type: 'file'; path: string }
  | { id: string; type: 'attachment'; label: string; name: string }
  | { id: string; type: 'command'; command: SlashCommand }
  | { id: string; type: 'skill'; skill: SkillInfo }
  | { id: string; type: 'plugin'; skill: SkillInfo }

function rankSkills(skills: readonly SkillInfo[], query: string, limit = 12, scope: 'skill' | 'plugin' = 'skill'): SkillInfo[] {
  return skills
    .filter((skill) => skill.enabled && (skill.scope === 'plugin') === (scope === 'plugin'))
    .flatMap((skill) => {
      const scores = [skill.name, skill.display_name ?? '', skill.description ?? ''].flatMap((value) => {
        const score = fuzzyScore(value, query)
        return score == null ? [] : [score]
      })
      return scores.length ? [{ skill, score: Math.min(...scores) }] : []
    })
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map(({ skill }) => skill)
}

function skillSourceLabel(scope: SkillInfo['scope']): string {
  switch (scope) {
    case 'project':
      return 'Project'
    case 'repo':
      return 'Repo'
    case 'user':
      return 'Personal'
    case 'app':
      return 'App'
    case 'plugin':
      return 'Plugin'
    case 'system':
    case 'admin':
      return 'System'
    default:
      return 'Provider'
  }
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s*:\s*/g, ': ')
    .replace(/(^|[\s:])(\w)/g, (_m, sep: string, c: string) => `${sep}${c.toUpperCase()}`)
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const parentPath = (p: string) => (p.lastIndexOf('/') === -1 ? '' : p.slice(0, p.lastIndexOf('/')))

// Native text buffers remount across navigation. Keep the associated wire parts
// with the draft, bounded independently of transcript history.
const referenceDrafts = new Map<string, { mentioned: Set<string>; picked: Map<string, SkillInfo>; threads: ComposerThreadReference[]; mentions: ComposerMentionReference[] }>()
onEnvironmentChange(() => referenceDrafts.clear())

export function useCompletion({
  draftKey,
  text,
  setText,
  caret = text.length,
  composing = false,
  edit,
  projectId,
  provider,
  currentThreadId,
  attachments,
  commands,
}: {
  draftKey: string
  text: string
  setText: (text: string) => void
  caret?: number
  composing?: boolean
  edit?: (start: number, end: number, replacement: string) => boolean
  projectId?: ProjectId
  provider?: { kind: ProviderKind; instance: string }
  currentThreadId?: string
  attachments: AttachmentReference[]
  commands: SlashCommand[]
}) {
  const threads = useApp((s) => s.threads)
  const projects = useApp((s) => s.projects)
  const [mentionRefs, setMentionRefs] = useState<ComposerMentionReference[]>(() => referenceDrafts.get(draftKey)?.mentions ?? [])
  const [mentioned, setMentioned] = useState<Set<string>>(() => referenceDrafts.get(draftKey)?.mentioned ?? new Set())
  const [picked, setPicked] = useState<Map<string, SkillInfo>>(() => referenceDrafts.get(draftKey)?.picked ?? new Map())
  const [threadRefs, setThreadRefs] = useState<ComposerThreadReference[]>(() => referenceDrafts.get(draftKey)?.threads ?? [])
  useEffect(() => {
    if (!text) { referenceDrafts.delete(draftKey); return }
    referenceDrafts.delete(draftKey)
    referenceDrafts.set(draftKey, { mentioned, picked, threads: threadRefs, mentions: mentionRefs })
    if (referenceDrafts.size > 100) referenceDrafts.delete(referenceDrafts.keys().next().value!)
  }, [draftKey, text, mentioned, picked, threadRefs, mentionRefs])
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sel, setSel] = useState<{ sig: string; index: number }>({ sig: '', index: 0 })
  const [files, setFiles] = useState<{ query: string; files: string[] }>({ query: '', files: [] })
  const [found, setFound] = useState<{ query: string; threads: { thread: Thread; snippet?: string | null }[] }>({ query: '', threads: [] })
  const [catalog, setCatalog] = useState<{ key: string; skills: SkillInfo[] }>({ key: '', skills: [] })

  // The chip picked for one `@` (keyed by its position); a new `@` starts on All.
  const [chip, setChip] = useState<{ key: string; filter: MentionFilter }>({ key: '', filter: 'all' })
  const [noteHits, setNoteHits] = useState<{ query: string; hits: ReadonlyMap<NoteId, string> }>({ query: '', hits: NO_HITS })
  const mention = useMemo(() => mentionAtCaret(text, caret), [text, caret])
  // `@note:login` searches notes for "login"; `term` is what every search uses.
  const scope = useMemo(() => (mention ? parseMentionQuery(mention.query) : null), [mention])
  const term = scope ? scope.term : null
  const mentionKey = mention ? `@${mention.start}` : null
  const filter: MentionFilter = scope?.kind ?? (chip.key === mentionKey ? chip.filter : 'all')
  // Notes and tasks are read only while the @ picker is up, so their changes never re-render an idle composer.
  const noteFeed = useNotes(s => (mention ? s.notes : NO_NOTES))
  const taskFeed = useTasks(s => (mention ? s.tasks : NO_TASKS))
  const slash = useMemo(() => {
    const start = text.lastIndexOf('/', caret - 1)
    if (start < 0 || (start > 0 && !/\s/.test(text[start - 1]!))) return null
    const token = text.slice(start + 1, caret)
    if (/\s/.test(token)) return null
    const skillOnly = token.toLowerCase().startsWith('skill:')
    return { start, query: skillOnly ? token.slice(6) : token, skillOnly }
  }, [text, caret])
  const skill = useMemo(() => {
    if (!projectId || !provider) return null
    const dollar = text.lastIndexOf('$', caret - 1)
    if (dollar < 0 || (dollar > 0 && !/\s/.test(text[dollar - 1]!))) return null
    const query = text.slice(dollar + 1, caret)
    if (!/^(?:[A-Za-z][A-Za-z0-9:_-]*)?$/.test(query)) return null
    return { start: dollar, query }
  }, [text, caret, projectId, provider])

  // Searches wait 60ms for typing to settle, as on the desktop.
  useEffect(() => {
    if (term === null) return
    let live = true
    const id = setTimeout(() => {
      const client = getClient()
      if (!client) return
      if (projectId)
        void client
          .call('files.search', { project_id: projectId, query: term, limit: 12 })
          .then((r) => live && setFiles({ query: term, files: r.files }))
          .catch(() => live && setFiles({ query: term, files: [] }))
      if (!term) { setFound({ query: '', threads: [] }); setNoteHits({ query: '', hits: NO_HITS }); return }
      void client
        .call('threads.search', { project_id: projectId ?? null, all_projects: true, query: term, limit: 12 })
        .then((r) => live && setFound({ query: term, threads: r.threads }))
        .catch(() => live && setFound({ query: term, threads: [] }))
      // Titles and previews match locally at once; the daemon adds body matches.
      void client
        .call('notes.search', { query: term, limit: 8 })
        .then((r) => live && setNoteHits({ query: term, hits: new Map(r.results.map((hit) => [hit.id, hit.snippet])) }))
        .catch(() => live && setNoteHits({ query: term, hits: NO_HITS }))
    }, 60)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [term, projectId])

  const catalogKey = projectId && provider ? `${projectId}:${provider.kind}:${provider.instance}` : ''
  const needsSkills = !!skill || !!slash || !!mention
  const mentionsOpen = !!mention
  useEffect(() => { if (mentionsOpen && getClient()) { void refreshNotes(); void refreshTasks() } }, [mentionsOpen])
  useEffect(() => {
    if (!needsSkills || !projectId || !provider) return
    let live = true
    void getClient()
      ?.call('skills.list', { project_id: projectId, provider: provider.kind, instance: provider.instance })
      .then((r) => live && setCatalog({ key: catalogKey, skills: r.skills }))
      .catch(() => live && setCatalog({ key: catalogKey, skills: [] }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsSkills, catalogKey])
  const skills = catalog.key === catalogKey ? catalog.skills : []

  const threadHits = useMemo(
    () =>
      term === ''
        ? threads
            .filter((th) => th.id !== currentThreadId && th.status !== 'archived' && !isChildThread(th))
            .sort((a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId) || Date.parse(b.updated_at) - Date.parse(a.updated_at))
            .slice(0, 12)
            .map((thread) => ({ thread }))
        : found.query === term
          ? found.threads.filter((hit) => hit.thread.id !== currentThreadId)
          : [],
    [term, threads, found, currentThreadId, projectId],
  )

  const mentionNotes = useMemo(() => {
    if (term === null) return { any: false, hits: [] as { note: NoteSummary; snippet: string | null }[] }
    // Shared Global notes live on This Mac; this environment's daemon cannot read them into a prompt.
    const shared = sharesHome()
    const list = noteFeed.filter((note) => !note.deleted_at && !(shared && note.scope === 'global'))
    return { any: list.length > 0, hits: rankMentionNotes(list, term, noteHits.query === term ? noteHits.hits : null, projectId) }
  }, [noteFeed, noteHits, projectId, term])
  const mentionTasks = useMemo(() => {
    if (term === null) return { any: false, hits: [] as TaskItem[] }
    const list = Object.values(taskFeed)
    return { any: list.length > 0, hits: rankMentionTasks(list, term, projectId, keyMatchesQuery) }
  }, [taskFeed, projectId, term])
  const anyThread = !!mention && threads.length > (currentThreadId ? 1 : 0)
  const anyPlugin = skills.some((item) => item.enabled && item.scope === 'plugin')
  // Chips for kinds that can have results; none when there is only one kind to show.
  const chips = useMemo<MentionFilter[]>(() => {
    if (!mention) return []
    const available: Record<MentionKind, boolean> = { thread: anyThread, note: mentionNotes.any, task: mentionTasks.any, file: !!projectId, plugin: anyPlugin }
    const kinds = MENTION_KINDS.filter((kind) => available[kind] || kind === filter)
    return kinds.length > 1 || filter !== 'all' ? ['all', ...kinds] : []
  }, [anyPlugin, anyThread, mention, filter, mentionNotes.any, mentionTasks.any, projectId])

  const items = useMemo<Item[]>(() => {
    if (mention && term !== null) {
      const byKind: Record<MentionKind, Item[]> = {
        thread: threadHits.map((hit) => ({ id: `thread:${hit.thread.id}`, type: 'thread' as const, ...hit })),
        note: mentionNotes.hits.map(({ note, snippet }) => ({ id: `note:${note.id}`, type: 'note' as const, note, snippet })),
        task: mentionTasks.hits.map((task) => ({ id: `task:${task.id}`, type: 'task' as const, task })),
        file: (files.query === term ? files.files : []).map((path) => ({ id: `file:${path}`, type: 'file' as const, path })),
        plugin: rankSkills(skills, term, 12, 'plugin').map((s) => ({ id: `plugin:${s.path}`, type: 'plugin' as const, skill: s })),
      }
      if (filter !== 'all') return byKind[filter]
      const attached: Item[] = attachments
        .filter((a) => a.part.type === 'attachment')
        .map((a) => ({ label: a.token.slice(1), name: a.part.type === 'attachment' ? a.part.name : '' }))
        .filter((a) => fuzzyScore(a.label, term) != null || fuzzyScore(a.name, term) != null)
        .map((a) => ({ id: `attachment:${a.label}`, type: 'attachment' as const, ...a }))
      // A few of each kind; when only one kind matches, all of it.
      const filled = MENTION_KINDS.filter((kind) => byKind[kind].length > 0).length + (attached.length ? 1 : 0)
      const cap = filled > 1 ? MENTION_ALL_PER_KIND : Infinity
      return [...attached, ...MENTION_KINDS.flatMap((kind) => byKind[kind].slice(0, cap))]
    }
    if (skill) return rankSkills(skills, skill.query).map((s) => ({ id: `skill:${s.name}`, type: 'skill' as const, skill: s }))
    if (!slash) return []
    const commandItems: Item[] = slash.skillOnly
      ? []
      : commands
          .flatMap((command) => {
            const scores = [fuzzyScore(command.name, slash.query), fuzzyScore(command.hint, slash.query)].filter((s): s is number => s != null)
            return scores.length ? [{ command, score: Math.min(...scores) }] : []
          })
          .sort((a, b) => a.score - b.score)
          .map(({ command }) => ({ id: `command:${command.name}`, type: 'command' as const, command }))
    const skillItems = rankSkills(skills, slash.query).map((s) => ({ id: `skill:${s.name}`, type: 'skill' as const, skill: s }))
    return [...commandItems, ...skillItems].slice(0, 16)
  }, [mention, term, filter, threadHits, files, skills, attachments, skill, slash, commands, mentionNotes, mentionTasks])

  const menuKey = mention ? `@${mention.start}` : skill ? `$${skill.start}` : slash ? `/${slash.start}` : null
  const open = !composing && !!menuKey && dismissed !== menuKey
  const signature = `${menuKey}:${mention ? filter : ''}:${items.map((item) => item.id).join('|')}`
  const index = sel.sig === signature ? sel.index : 0
  const wants = (kind: MentionKind) => filter === 'all' || filter === kind
  const loading =
    mention && term !== null ? (wants('file') && !!projectId && files.query !== term) || (wants('thread') && !!term && found.query !== term) : (!!skill || !!slash) && catalog.key !== catalogKey
  const empty =
    mention && term !== null
      ? loading
        ? 'Searching…'
        : mentionEmptyText(filter, term, !!projectId)
      : loading
        ? 'Loading agent skills…'
        : skill
          ? 'No matching skills'
          : 'No matching commands or skills'

  const replace = (start: number, token: string) => {
    if (/\s/.test(text[caret] ?? '') && token.endsWith(' ')) token = token.slice(0, -1)
    if (edit) return edit(start, caret, token)
    setText(`${text.slice(0, start)}${token}${text.slice(caret)}`)
    return true
  }

  const pick = (i: number) => {
    const item = items[i]
    if (!item) return
    if ((item.type === 'note' || item.type === 'task') && mention) {
      const part = item.type === 'note' ? noteMentionPart({ id: item.note.id, title: noteTitle(item.note) }) : taskMentionPart(item.task)
      const reference = createComposerMentionReference(part, mentionRefs, threadRefs.map(r => r.token))
      if (replace(mention.start, `${reference.token} `)) setMentionRefs(list => [...list.filter(r => r.part.path !== part.path), reference])
    } else if (item.type === 'thread' && mention) {
      const project = projects.find((p) => p.id === item.thread.project_id)
      const reference = createComposerThreadReference(item.thread, threadRefs, project?.name ?? 'Free chat')
      if (replace(mention.start, `${reference.token} `)) setThreadRefs((list) => [...list.filter((r) => r.part.thread_id !== item.thread.id), reference])
    } else if (item.type === 'file' && mention) {
      if (replace(mention.start, `@${item.path} `)) setMentioned((set) => new Set(set).add(item.path))
    } else if (item.type === 'attachment' && mention) {
      replace(mention.start, `@${item.label} `)
    } else if (item.type === 'plugin' && mention) {
      if (replace(mention.start, `@${item.skill.display_name ?? item.skill.name} `)) setPicked((map) => new Map(map).set(item.skill.path, item.skill))
    } else if (item.type === 'command' && slash) {
      if (replace(slash.start, '')) item.command.run()
    } else if (item.type === 'skill') {
      const trigger = skill ?? slash
      if (!trigger) return
      if (replace(trigger.start, `$${item.skill.name} `)) setPicked((map) => new Map(map).set(item.skill.name.toLowerCase(), item.skill))
    }
  }

  /** Show one kind (or All). A typed `note:` prefix gives way to the chip. */
  const selectFilter = (next: MentionFilter) => {
    if (!mention || !scope) return
    setChip({ key: `@${mention.start}`, filter: next })
    if (scope.kind && scope.kind !== next) {
      const from = mention.start + 1
      if (edit) edit(from, from + scope.prefixLength, '')
      else setText(`${text.slice(0, from)}${text.slice(from + scope.prefixLength)}`)
    }
  }

  /** Keys the textarea forwards while the list is up; true when handled. `other` is ⌥ or ⌘. */
  const onKey = (raw: string, shift: boolean, ctrl = false, other = false): boolean => {
    if (!open) return false
    // ←/→ switch the picker's chips until a term is typed; after that, and with a modifier, they move the caret.
    if (mention && chips.length > 1 && mentionArrowsSwitchChips(mention.query) && (raw === 'left' || raw === 'right') && !shift && !ctrl && !other) {
      const at = Math.max(0, chips.indexOf(filter))
      selectFilter(chips[(at + (raw === 'right' ? 1 : -1) + chips.length) % chips.length]!)
      return true
    }
    // ⌃N/⌃P are additional shortcuts for moving the list.
    const key = ctrl && raw === 'n' ? 'down' : ctrl && raw === 'p' ? 'up' : raw
    if (key === 'escape') {
      setDismissed(menuKey)
      return true
    }
    if (!items.length) return false
    if (key === 'down' || key === 'up') {
      const step = key === 'down' ? 1 : -1
      setSel(previous => ({ sig: signature, index: ((previous.sig === signature ? previous.index : 0) + step + items.length) % items.length }))
      return true
    }
    if (key === 'enter' && !shift) {
      pick(index)
      return true
    }
    if (key === 'tab') {
      // Native interception cancels the tab before it reaches the edit buffer.
      pick(index)
      return true
    }
    return false
  }

  const buildParts = (): ContentPart[] => {
    const skillItems = [...skills, ...picked.values()]
    return convertTypedSlashSkills(buildStructuredTextParts(text, mentioned, skillItems, threadRefs, attachments, mentionRefs), skillItems)
  }

  const reset = () => {
    setMentioned(new Set())
    setPicked(new Map())
    setThreadRefs([])
    setMentionRefs([])
  }

  const menu = (width: number) =>
    open ? (
    <CompletionList
      width={width}
      items={items}
      index={index}
      grouped={!mention || filter === 'all'}
      chips={mention ? chips : []}
      filter={filter}
      onFilter={selectFilter}
      empty={empty}
      projects={projects}
      threads={threads}
      onHover={(i) => setSel({ sig: signature, index: i })}
      onPick={pick}
    />
    ) : null

  const tokens = [
    ...mentionRefs.map(r => ({ token: r.token, label: inlineTokenLabel(mentionTokenKind(r.part.path), r.token) })),
    ...threadRefs.map(r => ({ token: r.token, label: inlineTokenLabel('thread', r.token) })),
    ...[...mentioned].map(path => ({ token: `@${path}`, label: path })),
    ...[...picked.values()].map(skill => skill.scope === 'plugin'
      ? { token: `@${skill.display_name ?? skill.name}`, label: skill.display_name ?? skill.name }
      : { token: `$${skill.name}`, label: skill.name }),
  ].filter(r => text.includes(r.token))
  return { menu, onKey, buildParts, reset, tokens, open: open && items.length > 0 }
}

const NO_NOTES: NoteSummary[] = []
const NO_TASKS: Record<string, TaskItem> = {}
const NO_HITS: ReadonlyMap<NoteId, string> = new Map()

function mentionEmptyText(filter: MentionFilter, term: string, hasProject: boolean): string {
  const query = term.trim()
  switch (filter) {
    case 'all':
      return query ? `No results for “${query}”` : 'Type to search threads, notes, tasks, and files'
    case 'thread':
      return query ? 'No matching threads' : 'No other threads yet'
    case 'note':
      return query ? 'No matching notes' : 'No notes yet'
    case 'task':
      return query ? 'No matching tasks' : 'No tasks yet'
    case 'file':
      return !hasProject ? 'Open a project chat to mention its files' : query ? 'No matching files' : 'No files in this project'
    case 'plugin':
      return query ? 'No matching plugins' : 'No plugins for this agent'
  }
}

function sectionOf(item: Item | undefined): string | null {
  if (!item) return null
  switch (item.type) {
    case 'thread': return 'Threads'
    case 'note': return 'Notes'
    case 'task': return 'Tasks'
    case 'attachment': return 'Attachments'
    case 'file': return 'Files'
    case 'command': return 'Commands'
    case 'plugin': return 'Plugins'
    default: return 'Skills'
  }
}

/** The row's leading glyph: `[&_[stroke]]:[stroke-width:2]` on everything but tasks. */
function RowIcon({ item, active }: { item: Item; active: boolean }) {
  const t = useTheme()
  const color = active ? t.text : t.v('--color-text-foreground'), style = { opacity: active ? 1 : 0.85 }
  if (item.type === 'task') return <StatusGlyph status={item.task.status} />
  const source =
    item.type === 'thread' ? G.message
      : item.type === 'note' ? G.note
        : item.type === 'command' ? item.command.icon
          : item.type === 'skill' ? G.skill
            : item.type === 'plugin' ? (item.skill.path === COMPUTER_MENTION_PATH ? G.laptop : G.plugin)
              : item.type === 'file' ? (diffFileIcons[getFileIconName(item.path)] ?? G.file)
                : item.type === 'attachment' ? (diffFileIcons[getFileIconName(item.name)] ?? G.file)
                  : G.file
  return <Icon source={source} size={16} color={color} style={style} />
}

function CompletionList({
  width,
  items,
  index,
  grouped,
  chips,
  filter,
  onFilter,
  empty,
  projects,
  threads,
  onHover,
  onPick,
}: {
  width: number
  items: Item[]
  index: number
  grouped: boolean
  chips: MentionFilter[]
  filter: MentionFilter
  onFilter: (filter: MentionFilter) => void
  empty: string
  projects: { id: string; name: string }[]
  threads: Thread[]
  onHover: (i: number) => void
  onPick: (i: number) => void
}) {
  const t = useTheme()
  const windowHeight = useNativeWindowSize().height
  const lookups = useMemo(() => ({
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    threads: Object.fromEntries(threads.map((th) => [th.id, th])),
  }), [projects, threads])
  const projectName = (id: string | null | undefined) => (id && !isFreeChatProject(id) ? lookups.projects[id]?.name : undefined)
  return (
    <FloatingLayer
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={8}
      testId="completion"
      style={{ ...popoverStyle(t), borderRadius: PICKER_RADIUS, display: 'flex', flexDirection: 'column', width, overflow: 'hidden' }}
    >
      {chips.length > 1 && <MentionChips chips={chips.map((id) => ({ id, label: MENTION_FILTER_LABEL[id] }))} active={filter} onSelect={onFilter} />}
      <div style={{ display: 'flex', flexDirection: 'column', padding: 6, overflowY: 'scroll', minHeight: 0, maxHeight: Math.min(352, windowHeight * 0.45) }}>
      {items.length === 0 ? (
        <div style={{ display: 'flex', paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8 }}>
          <Label color={muted(t, 0.6)} size={13} lineHeight={20}>
            {empty}
          </Label>
        </div>
      ) : (
        items.map((item, i) => {
          const active = i === index
          const section = sectionOf(item)
          const title =
            item.type === 'note' ? noteTitle(item.note)
              : item.type === 'task' ? item.task.title.trim() || 'Untitled task'
                : item.type === 'thread' ? item.thread.title || 'Untitled thread'
                  : item.type === 'attachment' ? `@${item.label}`
                    : item.type === 'file' ? basename(item.path)
                      : item.type === 'command' ? titleCase(item.command.name)
                        : item.skill.display_name ?? titleCase(item.skill.name)
          const description =
            item.type === 'thread' ? item.snippet
              : item.type === 'note' ? item.snippet ?? item.note.preview
                : item.type === 'attachment' ? item.name
                  : item.type === 'command' ? item.command.hint
                    : item.type === 'skill' || item.type === 'plugin' ? item.skill.description
                      : null
          return (
            <div key={item.id} style={{ display: 'flex', flexDirection: 'column' }}>
              {grouped && section !== sectionOf(items[i - 1]) && (
                <div style={{ display: 'flex', paddingLeft: 10, paddingRight: 10, paddingTop: i > 0 ? 10 : 4, paddingBottom: 4 }}>
                  <Label color={muted(t, 0.6)} size={13} weight={500}>
                    {section!}
                  </Label>
                </div>
              )}
              <div
                testId={`completion-${i}`}
                aria-selected={active}
                onMouseMove={() => !active && onHover(i)}
                onClick={() => onPick(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 36,
                  paddingLeft: 10,
                  paddingRight: 10,
                  paddingTop: 6,
                  paddingBottom: 6,
                  borderRadius: 8,
                  cursor: 'pointer',
                  ...(active ? { backgroundColor: t.buttonSecondary } : {}),
                  hover: { backgroundColor: active ? t.buttonSecondary : t.buttonSecondaryHover },
                }}
              >
                <div style={{ display: 'flex', width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
                  <RowIcon item={item} active={active} />
                </div>
                <div testId={active ? 'completion-selected' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>
                    {item.type === 'task' && <Label color={muted(t, 0.6)} size={13} style={{ flexShrink: 0 }}>{item.task.key}</Label>}
                    <Label color={t.text} truncate style={{ flexShrink: 0, maxWidth: '60%' }}>
                      {title}
                    </Label>
                    {description && description !== title && (
                      <Label color={muted(t, 0.7)} truncate style={{ flexGrow: 1 }}>
                        {description}
                      </Label>
                    )}
                  </div>
                  <Trailing item={item} projectName={projectName} scopeLabel={item.type === 'note' ? noteScopeLabel(item.note, lookups.projects as never, lookups.threads as never) : ''} />
                </div>
              </div>
            </div>
          )
        })
      )}
      </div>
    </FloatingLayer>
  )
}

/** The right-hand column of a row: project, scope, path or source, at 45% ink. */
function Trailing({ item, projectName, scopeLabel }: { item: Item; projectName: (id: string | null | undefined) => string | undefined; scopeLabel: string }) {
  const t = useTheme()
  const tail = (text: string, mono = false) => <Label color={muted(t, mono ? 0.4 : 0.45)} size={13} truncate style={{ flexShrink: 0, maxWidth: '38%' }} {...(mono ? { font: FONT_MONO } : {})}>{text}</Label>
  switch (item.type) {
    case 'thread': return tail(isFreeChatProject(item.thread.project_id) ? 'Free chat' : projectName(item.thread.project_id) ?? 'Project')
    case 'file': return tail(parentPath(item.path))
    case 'attachment': return null
    case 'command': return tail(`/${item.command.name}`, true)
    case 'note': return <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexShrink: 0, maxWidth: '38%' }}>
      {(item.note.checklist?.total ?? 0) > 0 && <Label color={muted(t, 0.45)} size={13} style={{ flexShrink: 0 }}>{`${item.note.checklist!.done}/${item.note.checklist!.total}`}</Label>}
      <Label color={muted(t, 0.45)} size={13} truncate>{scopeLabel}</Label>
    </div>
    case 'task': return <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, maxWidth: '38%' }}>
      {item.task.priority !== 0 && <PriorityGlyph priority={item.task.priority} />}
      <Label color={muted(t, 0.45)} size={13} truncate>{item.task.scope === 'global' || !item.task.project_id ? 'Global' : projectName(item.task.project_id) ?? 'Project'}</Label>
    </div>
    default: return <Label color={muted(t, 0.55)} size={13} style={{ flexShrink: 0 }}>{skillSourceLabel(item.skill.scope)}</Label>
  }
}
