import { classifyPreviewInput, previewDisplay, type PreviewContext } from '../../../../packages/kybern-client/src/previewTarget.ts'
import type { Entry } from './store.ts'

/** Match PreviewChromeRow: file breadcrumbs follow bridge navigation. */
export function currentAddress(entry: Entry, bridgePath?: string, context: PreviewContext = {}) {
  const target = entry.target
  if (entry.kind === 'file' && target?.kind === 'file') {
    const path = bridgePath ? `${target.root.replace(/\/+$/, '')}/${bridgePath.replace(/^\/+/, '')}` : target.path
    const relative = target.in_project && path.startsWith(`${target.root}/`) ? path.slice(target.root.length + 1) : undefined
    return previewDisplay({ kind: 'file', path, relative }, context)
  }
  return previewDisplay(entry.query ? { kind: 'search', query: entry.query } : classifyPreviewInput(entry.address, context), context)
}

/** Files retain their opaque sandbox: reload via the actual ticket-relative path. */
export function reloadAddress(entry: Entry, bridgePath?: string, fresh = false, now = Date.now()) {
  const url = new URL(entry.frameUrl ?? entry.url)
  const base = /^(.*\/preview-files\/[^/]+\/)/.exec(entry.url)?.[1]
  const result = entry.kind === 'file' && base && bridgePath ? new URL(`${base}${bridgePath.replace(/^\/+/, '')}`) : url
  if (base && !result.href.startsWith(base)) throw Error('Invalid preview file path')
  if (fresh && entry.kind === 'server') result.searchParams.set('__kybern_reload', String(now))
  return result.href
}

/** The address the browser opens: a local file or the server's own address; with no embedded view, a server on another machine opens through the local relay. */
export function browserAddress(entry: Entry, pagePath: string | undefined, local: boolean, embedded: boolean): string {
  if (entry.kind === 'file') return `file://${currentAddress(entry, pagePath).full}`
  return !embedded && !local && entry.frameUrl ? entry.frameUrl : entry.address
}
