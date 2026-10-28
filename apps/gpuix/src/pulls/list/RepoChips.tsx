import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { PickerChip } from '../../kit/PickerChip.tsx'
import { EDGE_FADE } from '../../native/local-build.ts'
import { observeElementBounds } from '../../native/layout.ts'
import type { Project } from '../../../../../packages/kybern-client/src/types.ts'
import { chooseRepo, listableMembers, type Scope } from './model.ts'

/**
 * One chip per repository of the selected group project, plus All. One click shows just that repository. When the
 * group has more repositories than fit, the row scrolls sideways and fades at the edge that has more.
 */
export function RepoChips({ project, scope, onChange }: { project: Project; scope: Scope; onChange: (scope: Scope) => void }) {
  const { renderer } = useGpuix()
  const scroll = useRef<PublicInstance | null>(null)
  const inner = useRef<PublicInstance | null>(null)
  const [extent, setExtent] = useState({ view: 0, content: 0, offset: 0 })
  const members = listableMembers(project)
  const shown = members.length >= 2
  useEffect(() => {
    if (!renderer || !shown || !scroll.current || !inner.current) return
    const view = observeElementBounds(renderer, scroll.current.id, e => { if (e.rect) setExtent(x => x.view === e.rect!.width ? x : { ...x, view: e.rect!.width }) })
    const content = observeElementBounds(renderer, inner.current.id, e => { if (e.rect) setExtent(x => x.content === e.rect!.width ? x : { ...x, content: e.rect!.width }) })
    return () => { view(); content() }
  }, [renderer, shown])
  if (!shown) return null
  const readOffset = () => { if (scroll.current) { const offset = renderer?.getScrollOffset?.(scroll.current.id)?.[0] ?? 0; setExtent(x => x.offset === offset ? x : { ...x, offset }) } }
  const overflowing = extent.content > extent.view + 0.5
  const fade = overflowing && EDGE_FADE ? { left: extent.offset < -0.5 ? 16 : 0, right: extent.content + extent.offset > extent.view + 0.5 ? 16 : 0 } : undefined
  const whole = scope.repos.length === 0
  return <div ref={scroll} testId="pr-repo-chips" role="group" aria-label="Repository" onScroll={readOffset} edgeFade={fade} style={{ display: 'flex', alignItems: 'center', minWidth: 0, flexShrink: 0, overflowX: 'scroll', overflowY: 'hidden' }}>
    <div ref={inner} style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <PickerChip size="sm" chevron={false} selected={whole} quiet={!whole} muted testId="pr-repo-all" onClick={() => onChange(chooseRepo(project, null))}>All</PickerChip>
      {members.map(m => {
        const on = scope.repos.includes(m.path)
        return <PickerChip key={m.path} size="sm" chevron={false} quiet={!on} selected={on} muted testId={`pr-repo-${m.path}`} onClick={() => onChange(chooseRepo(project, m.path))}>{m.name}</PickerChip>
      })}
    </div>
  </div>
}
