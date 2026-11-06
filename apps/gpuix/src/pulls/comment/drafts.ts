// What was typed in an issue's or a pull request's comment box, kept per issue in the UI store, so it survives switching
// issues, tabs and restarts. Empty drafts are dropped; the 40 most recent are kept.
import { load, save } from '../persist.ts'

const KEY = 'pulls.comment-drafts'
const LIMIT = 40
const MAX_CHARS = 65_536

/** One issue or pull request: `repo` is a group project's member. */
export const draftKey = (projectId: string, number: number, repo?: string) => `${projectId}/${repo ?? ''}:${number}`

function all(): Record<string, string> {
  const value = load<Record<string, unknown>>(KEY, {})
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
}

export function readDraft(key: string): string {
  return all()[key] ?? ''
}

export function saveDraft(key: string, text: string) {
  const { [key]: _old, ...rest } = all()
  const kept = Object.entries(rest).slice(-(LIMIT - 1))
  save(KEY, Object.fromEntries(text.trim() ? [...kept, [key, text.slice(0, MAX_CHARS)]] : kept))
}
