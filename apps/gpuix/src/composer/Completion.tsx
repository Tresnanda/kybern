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
import { useEffect, useMemo, useState } from 'react'
import {
  fuzzyScore,
  MENTION_ALL_PER_KIND,
  mentionAtCaret,
  parseMentionQuery,
} from '../../../desktop/src/views/composerMentions.ts'
import {
  buildStructuredTextParts,
  createComposerMentionReference,
  type ComposerMentionReference,
  convertTypedSlashSkills,
  type AttachmentReference,
} from '../../../../packages/kybern-client/src/composerTokens.ts'
import { createComposerThreadReference, type ComposerThreadReference } from '../../../../packages/kybern-client/src/threadReferences.ts'
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import type { ContentPart, ProjectId, ProviderKind, SkillInfo, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { G } from './glyphs.ts'
import { muted, PICKER_RADIUS, popoverStyle } from './Menu.tsx'

export interface SlashCommand {
  name: string
  hint: string
  icon: string
  run: () => void
}

type Item =
  | { id: string; type: 'reference'; label: string; path: string; section: 'Notes' | 'Tasks' | 'Computer' }
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
  const notes = useNotes(s => s.notes)
  const tasks = useTasks(s => s.tasks)
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

  const mention = useMemo(() => mentionAtCaret(text, caret), [text, caret])
  const term = mention ? parseMentionQuery(mention.query).term : null
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
      if (!term) return setFound({ query: '', threads: [] })
      void client
        .call('threads.search', { project_id: projectId ?? null, all_projects: true, query: term, limit: 12 })
        .then((r) => live && setFound({ query: term, threads: r.threads }))
        .catch(() => live && setFound({ query: term, threads: [] }))
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

  const items = useMemo<Item[]>(() => {
    if (mention && term !== null) {
      const references: Item[] = [
        ...notes.filter(n => !n.deleted_at && (!n.project_id || n.project_id === projectId) && fuzzyScore(n.title, term) != null).slice(0, 12).map(n => ({ id: `note:${n.id}`, type: 'reference' as const, label: n.title || 'Untitled', path: `kybern://note/${n.id}`, section: 'Notes' as const })),
        ...Object.values(tasks).filter(task => (!task.project_id || task.project_id === projectId) && fuzzyScore(`${task.key} ${task.title}`, term) != null).slice(0, 12).map(task => ({ id: `task:${task.id}`, type: 'reference' as const, label: `${task.key} ${task.title}`, path: `kybern://task/${task.id}`, section: 'Tasks' as const })),
        ...(skills.some(s => s.path === 'kybern://computer' && s.enabled) && fuzzyScore('Computer', term) != null ? [{ id: 'computer', type: 'reference' as const, label: 'Computer', path: 'kybern://computer', section: 'Computer' as const }] : []),
      ]
      const byKind: Item[][] = [
        references,
        threadHits.map((hit) => ({ id: `thread:${hit.thread.id}`, type: 'thread' as const, ...hit })),
        (files.query === term ? files.files : []).map((path) => ({ id: `file:${path}`, type: 'file' as const, path })),
        rankSkills(skills, term, 12, 'plugin').map((s) => ({ id: `plugin:${s.path}`, type: 'plugin' as const, skill: s })),
      ]
      const attached: Item[] = attachments
        .filter((a) => a.part.type === 'attachment')
        .map((a) => ({ label: a.token.slice(1), name: a.part.type === 'attachment' ? a.part.name : '' }))
        .filter((a) => fuzzyScore(a.label, term) != null || fuzzyScore(a.name, term) != null)
        .map((a) => ({ id: `attachment:${a.label}`, type: 'attachment' as const, ...a }))
      const filled = byKind.filter((list) => list.length > 0).length + (attached.length ? 1 : 0)
      const cap = filled > 1 ? MENTION_ALL_PER_KIND : Infinity
      return [...attached, ...byKind.flatMap((list) => list.slice(0, cap))]
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
  }, [mention, term, threadHits, files, skills, attachments, skill, slash, commands, notes, tasks, projectId])

  const menuKey = mention ? `@${mention.start}` : skill ? `$${skill.start}` : slash ? `/${slash.start}` : null
  const open = !composing && !!menuKey && dismissed !== menuKey
  const signature = `${menuKey}:${items.map((item) => item.id).join('|')}`
  const index = sel.sig === signature ? sel.index : 0
  const loading =
    mention && term !== null ? (!!projectId && files.query !== term) || (!!term && found.query !== term) : (!!skill || !!slash) && catalog.key !== catalogKey
  const empty =
    mention && term !== null
      ? loading
        ? 'Searching…'
        : term.trim()
          ? `No results for “${term.trim()}”`
          : 'Type to search threads, notes, tasks, and files'
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
    if (item.type === 'reference' && mention) {
      const reference = createComposerMentionReference({ type: 'mention', name: item.label, path: item.path }, mentionRefs, threadRefs.map(r => r.token))
      if (replace(mention.start, `${reference.token} `)) setMentionRefs(list => [...list.filter(r => r.part.path !== item.path), reference])
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

  /** Keys the textarea forwards while the list is up; true when handled. */
  const onKey = (raw: string, shift: boolean, ctrl = false): boolean => {
    if (!open) return false
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
      grouped={true}
      empty={empty}
      projects={projects}
      onHover={(i) => setSel({ sig: signature, index: i })}
      onPick={pick}
    />
    ) : null

  const tokens = [
    ...mentionRefs.map(r => ({ token: r.token, label: r.part.name })),
    ...threadRefs.map(r => ({ token: r.token, label: r.token.slice(1) })),
    ...[...mentioned].map(path => ({ token: `@${path}`, label: basename(path) })),
  ].filter(r => text.includes(r.token))
  return { menu, onKey, buildParts, reset, tokens, open: open && items.length > 0 }
}

function sectionOf(item: Item | undefined): string | null {
  if (!item) return null
  if (item.type === 'reference') return item.section
  return item.type === 'thread'
    ? 'Threads'
    : item.type === 'attachment'
      ? 'Attachments'
      : item.type === 'file'
        ? 'Files'
        : item.type === 'command'
          ? 'Commands'
          : item.type === 'plugin'
            ? 'Plugins'
            : 'Skills'
}

function CompletionList({
  width,
  items,
  index,
  grouped,
  empty,
  projects,
  onHover,
  onPick,
}: {
  width: number
  items: Item[]
  index: number
  grouped: boolean
  empty: string
  projects: { id: string; name: string }[]
  onHover: (i: number) => void
  onPick: (i: number) => void
}) {
  const t = useTheme()
  return (
    <FloatingLayer
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={8}
      testId="completion"
      style={{ ...popoverStyle(t), borderRadius: PICKER_RADIUS, display: 'flex', flexDirection: 'column', width, maxHeight: 352, padding: 6, overflowY: 'scroll' }}
    >
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
            item.type === 'reference' ? item.label : item.type === 'thread'
              ? item.thread.title || 'Untitled thread'
              : item.type === 'attachment'
                ? `@${item.label}`
                : item.type === 'file'
                  ? basename(item.path)
                  : item.type === 'command'
                    ? titleCase(item.command.name)
                    : item.skill.display_name ?? titleCase(item.skill.name)
          const description =
            item.type === 'thread'
              ? item.snippet
              : item.type === 'attachment'
                ? item.name
                : item.type === 'command'
                  ? item.command.hint
                  : item.type === 'skill' || item.type === 'plugin'
                    ? item.skill.description
                    : null
          const trailing =
            item.type === 'thread'
              ? projects.find((p) => p.id === item.thread.project_id)?.name ?? 'Free chat'
              : item.type === 'file'
                ? parentPath(item.path)
                : item.type === 'command'
                  ? `/${item.command.name}`
                  : item.type === 'skill' || item.type === 'plugin'
                    ? skillSourceLabel(item.skill.scope)
                    : null
          const icon =
            item.type === 'thread'
              ? G.message
              : item.type === 'command'
                ? item.command.icon
                : item.type === 'skill'
                  ? G.skill
                  : item.type === 'plugin'
                    ? G.plugin
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
                {icon ? (
                  <Icon source={icon} size={16} color={active ? t.text : t.v('--color-text-foreground')} style={{ opacity: active ? 1 : 0.85 }} />
                ) : (
                  <Icon name="file" size={16} color={t.text} style={{ opacity: active ? 1 : 0.85 }} />
                )}
                <div testId={active ? 'completion-selected' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexGrow: 1, minWidth: 0, overflow: 'hidden' }}>
                    <Label color={t.text} truncate style={{ flexShrink: 0, maxWidth: '60%' }}>
                      {title}
                    </Label>
                    {description && description !== title && (
                      <Label color={muted(t, 0.7)} truncate style={{ flexGrow: 1 }}>
                        {description}
                      </Label>
                    )}
                  </div>
                  {trailing && (
                    <Label color={muted(t, 0.45)} size={13} truncate style={{ flexShrink: 0, maxWidth: '38%' }}>
                      {trailing}
                    </Label>
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}
    </FloatingLayer>
  )
}
