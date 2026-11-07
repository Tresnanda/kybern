import { chatLink } from './chatLinks.ts'
export type LinkIcon = { kind: 'issue' | 'pull'; owner: string; repo: string; number: number } | { kind: 'github' | 'web' | 'file' | 'none' }
export type LinkMetadata = { state?: 'open' | 'completed' | 'merged' | 'not_planned' | 'draft'; favicon?: string }
export function classifyLink(href: string): LinkIcon {
  let url: URL
  try { url = new URL(href) } catch { return { kind: chatLink(href).kind === 'file' ? 'file' : 'none' } }
  if (url.protocol === 'file:') return { kind: 'file' }
  if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'none' }
  if (url.hostname.toLowerCase() !== 'github.com') return { kind: 'web' }
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)(?:\/|$)/.exec(url.pathname)
  return match && Number.isSafeInteger(Number(match[4])) ? { kind: match[3] === 'pull' ? 'pull' : 'issue', owner: match[1]!, repo: match[2]!, number: Number(match[4]) } : { kind: 'github' }
}
export function linkStateColor(state: LinkMetadata['state']): string | undefined {
  return state === 'open' ? '#1a7f37' : state === 'completed' || state === 'merged' ? '#8250df' : state === 'not_planned' || state === 'draft' ? '#848d97' : undefined
}
/** Destinations only; the renderer keeps labels and their formatting unchanged. */
export function markdownLinks(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/(?<!!)\[[^\]\n]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g)) out.add((m[1] ?? m[2])!)
  for (const m of source.matchAll(/<?https?:\/\/[^\s<>\])]+/g)) out.add(m[0].replace(/^</, ''))
  return [...out].slice(0, 128).sort((a, b) => b.length - a.length)
}
