import { useEffect, useMemo, useState } from 'react'
import { classifyLink, markdownLinks, linkStateColor, opaqueColor, replyFavicon, type LinkMetadata } from '../../../../packages/kybern-client/src/linkIcons.ts'
import { chatLink } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { threadClient } from '../state.ts'
import type { Theme } from '../theme.ts'
import { T } from './glyphs.ts'
import { N } from '../nav/glyphs.ts'
import { tinted } from './kit.tsx'
import { getFileIconName } from '../shared/lib/kit/fileIcons.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'

const cache = new Map<string, { until: number; value: LinkMetadata }>()
export function useLinkIcons(source: string, threadId: string | null, t: Theme) {
  const links = useMemo(() => markdownLinks(source), [source])
  const [metadata, setMetadata] = useState<Record<string, LinkMetadata>>({})
  useEffect(() => {
    let live = true
    const abort = new AbortController()
    const client = threadClient(threadId)
    if (!client) return
    void (async () => {
      // Sequential, bounded work per prose row. No timer or animation on settled text.
      for (const href of links) {
        if (!live) break
        const kind = classifyLink(href).kind
        if (!['issue', 'pull', 'web'].includes(kind)) continue
        const key = `${threadId}:${href}`, hit = cache.get(key)
        let value = hit && hit.until > Date.now() ? hit.value : undefined
        if (!value) {
          try { const response = await client.fetch(`/links/icon?url=${encodeURIComponent(href)}`, { signal: abort.signal }); value = response.ok ? await response.json() as LinkMetadata : {} } catch { value = {} }
          if (abort.signal.aborted) break
          if (cache.size >= 256) cache.delete(cache.keys().next().value!)
          cache.set(key, { until: Date.now() + 300_000, value })
        }
        if (live) setMetadata(old => ({ ...old, [href]: value! }))
      }
    })()
    return () => { live = false; abort.abort() }
  }, [links, threadId])
  return useMemo(() => {
    // Behind a site icon that would be hard to see: the secondary ink, or full ink where that is not enough. Both opaque.
    const plates = [opaqueColor(t.textSecondary, t.surface), t.text]
    return links.flatMap(href => {
      const target = classifyLink(href), data = metadata[href]
      let svg: string
      const color = linkStateColor(data?.state) ?? t.textSecondary
      switch (target.kind) {
        case 'issue': svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="${color}"/></svg>`; break
        case 'pull': svg = tinted(N.pullRequest, color); break
        case 'github': svg = tinted(T.github, t.textSecondary); break
        case 'file': { const file = chatLink(href); svg = tinted(diffFileIcons[getFileIconName(file.kind === 'file' ? file.path : href)] ?? T.file, t.textSecondary); break }
        case 'web': { const icon = data && replyFavicon(data, t.surface, plates); svg = icon ? faviconSvg(icon.src, icon.plate) : tinted(T.globe, t.textSecondary); break }
        default: return []
      }
      return [{ prefix: href, svg, color: '' }]
    })
  }, [links, metadata, t])
}

/** A site icon in the link's icon slot; on a plate it is inset so the plate shows around it. */
export function faviconSvg(src: string, plate?: string): string {
  return plate
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${plate}"/><image href="${src}" x="2.5" y="2.5" width="11" height="11"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><image href="${src}" width="16" height="16"/></svg>`
}
