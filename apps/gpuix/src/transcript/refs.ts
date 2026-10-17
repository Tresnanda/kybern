// `kybern://note/<id>` and `kybern://task/<id>` in an answer read as chips (`KybernRefChip`): the
// label follows the item, so a rename shows without a refresh, and bare URIs become links.
import type { NoteSummary, TaskItem } from '../../../../packages/kybern-client/src/types.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BARE = new RegExp(`(?<![\\w/:.@(<\\[-])kybern://(note|task)/(${UUID})/?(?![\\w-])`, 'gi')
const LINK = new RegExp(`\\[((?:\\\\.|[^\\]\\\\])*)\\]\\((<?)kybern://(note|task)/(${UUID})/?>?\\)`, 'gi')

const escape = (label: string) => label.replace(/([\\[\]])/g, '\\$1')
const written = (label: string) => { const text = label.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim(); return /^kybern:\/\//i.test(text) ? '' : text }

/** The answer with every note and task reference as a link labelled by its live title. */
export function chipifyKybernRefs(markdown: string, notes: ReadonlyMap<string, NoteSummary> | ((id: string) => NoteSummary | undefined), tasks: (id: string) => TaskItem | undefined): string {
  if (!markdown.includes('kybern://')) return markdown
  const note = typeof notes === 'function' ? notes : (id: string) => notes.get(id)
  const label = (target: string, id: string, fallback: string) => {
    if (target.toLowerCase() === 'task') {
      const task = tasks(id)
      return (task && [task.key, task.title.trim()].filter(Boolean).join(' ')) || written(fallback) || 'Task'
    }
    const item = note(id)
    return (item && !item.deleted_at && item.title.trim()) || written(fallback) || 'Untitled note'
  }
  let fence: string | null = null
  return markdown.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null; return line }
    if (marker) { fence = marker[1]!; return line }
    // Inline code keeps its source: only the stretches between backtick spans are rewritten.
    return line.split(/(`+[^`]*`+)/).map((piece, i) => i % 2 ? piece : piece
      .replace(LINK, (_all, text: string, _angle: string, target: string, id: string) => `[${escape(label(target, id.toLowerCase(), text))}](kybern://${target.toLowerCase()}/${id.toLowerCase()})`)
      .replace(BARE, (_all, target: string, id: string) => `[${escape(label(target, id.toLowerCase(), ''))}](kybern://${target.toLowerCase()}/${id.toLowerCase()})`)).join('')
  }).join('\n')
}
