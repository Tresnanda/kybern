// The chats an import skipped (v1 SPEC §6, "View skipped"), pure: the toast's and the Projects scene's line, and the dialog's groups.
import { count, noun } from './model.ts'

export interface SkippedChat { project: string; title: string; reason: string; detail: string }
export interface SkippedGroup { project: string; chats: SkippedChat[] }

/** "3 chats were skipped". */
export function skippedTitle(n: number): string {
  return `${count(n, 'chat')} ${noun(n, 'was', 'were')} skipped`
}

/** The skipped chats by project, projects in the order they first skipped one, chats in the order the daemon reported them. */
export function groupSkipped(skips: readonly SkippedChat[]): SkippedGroup[] {
  const groups = new Map<string, SkippedChat[]>()
  for (const skip of skips) {
    const list = groups.get(skip.project)
    if (list) list.push(skip)
    else groups.set(skip.project, [skip])
  }
  return [...groups].map(([project, chats]) => ({ project, chats }))
}

/** Skips beyond what the summary keeps in detail (it holds the latest 200), so the dialog can say so instead of undercounting. */
export const unlistedSkips = (total: number, listed: number) => Math.max(0, total - listed)
