// The Summary tab: the heading and the description in a scrolling list, the sidebar beside it. Wide, the sidebar is its own column
// outside the list, so it stays put while the description scrolls (the list keeps `PR_SCROLL_LAYOUT`: cached layout and its island, so
// a scroll frame lays out the description only). Narrow, the sidebar leads the list, under the header, as one column.
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { PublicInstance } from '@gpuix/react'
import { DocumentMarkdown } from '../../native/markdownDocument.tsx'
import { cachedMarkdownTheme as markdownTheme } from '../../transcript/kit.tsx'
import { useTheme } from '../../ui.tsx'
import { column } from '../../usage/controls.tsx'
import type { PrDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { openUrl } from '../PrStates.tsx'
import { PR_SCROLL_LAYOUT } from '../scroll-layout.ts'
import { useReadingPosition } from '../useReadingPosition.ts'
import { Heading } from './Heading.tsx'

/** Below this the sidebar folds under the header. */
export const SIDEBAR_BREAKPOINT = 832
/**
 * The description's reading width (about 75 characters at 14 px). Fenced code wraps inside it: the native document Markdown has no
 * sideways scroller of its own, and a clipped line hides the end of a path or a command.
 */
const READING_WIDTH = 680

export function Summary({ detail, projectId, repo, repoName, width, side, viewKey }: { viewKey?: string; detail: PrDetailResult; projectId: string; repo?: string; repoName: string; width: number; side: ReactNode }) {
  const [bodyReady, setBodyReady] = useState(false)
  const bodyMounted = useCallback((node: PublicInstance | null) => { if (viewKey) setBodyReady(!!node) }, [viewKey])
  const scroll = useReadingPosition(viewKey, 'summary', !viewKey || bodyReady)
  const t = useTheme()
  const compact = width < SIDEBAR_BREAKPOINT
  const theme = useMemo(() => { const base = markdownTheme(t); return { ...base, markdown: { ...base.markdown, codeWrap: true } } }, [t])
  const body = detail.body.replace(/<!--[\s\S]*?-->/g, '').trim()
  const description = <div testId="pr-body" style={{ ...column, maxWidth: READING_WIDTH, marginTop: 24, paddingTop: 22, borderTopWidth: 1, borderColor: t.surfaceDivider }}><DocumentMarkdown ref={viewKey ? bodyMounted : undefined} source={body || 'No description provided.'} theme={theme} style={{ color: t.text, fontSize: 14, userSelect: 'text' }} onLinkClick={e => e.value && openUrl(e.value)} /></div>
  const heading = <Heading detail={detail} projectId={projectId} {...(repo ? { repo } : {})} repoName={repoName} compact={compact} />
  if (compact) {
    return <virtual-list ref={scroll} {...PR_SCROLL_LAYOUT} testId="pr-summary" style={{ flexGrow: 1, minHeight: 0 }} estimatedItemHeight={400}><div key="summary" style={{ ...column, gap: 18, padding: 16, paddingTop: 12, paddingBottom: 64 }}>{side}<div style={column}>{heading}{description}</div></div></virtual-list>
  }
  return (
    <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
      <virtual-list ref={scroll} {...PR_SCROLL_LAYOUT} testId="pr-summary" style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }} estimatedItemHeight={400}><div key="summary" style={{ ...column, paddingLeft: 40, paddingRight: 40, paddingTop: 28, paddingBottom: 64 }}>{heading}{description}</div></virtual-list>
      {side}
    </div>
  )
}
