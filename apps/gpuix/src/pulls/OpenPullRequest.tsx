import { useEffect, useMemo, useState } from 'react'
import { getState, useApp } from '../state.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { Button } from '../kit/Button.tsx'
import { Label, useTheme } from '../ui.tsx'
import { column, row } from '../usage/controls.tsx'
import { PrLoading } from './PrStates.tsx'
import { loadKnownPulls, resolveKnownPull } from './knownPulls.ts'
import { prCall } from './client.ts'
import { memberName } from './list/model.ts'
import { githubPull, matchingPulls, resolvePull, targetOf, type PrTarget } from './tabTargets.ts'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'

export const knownPulls = (projects: readonly Project[]) => loadKnownPulls(projects, prCall)

/** Transcript links use the same known-network boundary and owning-project routing as the picker. */
export async function knownPullTarget(url: string): Promise<PrTarget | null> {
  return resolveKnownPull(url, getState().projects, prCall)
}

export function OpenPullRequest({ onOpen, onClose }: { onOpen: (target: PrTarget) => void; onClose: () => void }) {
  const t = useTheme()
  // Deliberately all merged network projects, independent of the active Space.
  const projects = useApp(s=>s.projects)
  const [query,setQuery] = useState('')
  const [data,setData] = useState<Awaited<ReturnType<typeof knownPulls>> | null>(null)
  useEffect(()=> { let live=true; setData(null); void knownPulls(projects).then(value=>{if(live)setData(value)}); return ()=>{live=false} },[projects])
  const matches = useMemo(()=>matchingPulls(data?.rows ?? [],query),[data,query])
  const url = githubPull(query)
  const target = data && url ? resolvePull(query,data.repos):null
  const open = (target: PrTarget) => {onOpen(target);onClose()}
  return <Dialog testId="pr-picker" onClose={onClose} width={600}>
    <DialogHeader title="Open pull request" description="Search known projects on your machines, or paste a GitHub pull request URL." onClose={onClose}/>
    <div style={{...column,padding:16,gap:12}}>
      <SearchField testId="pr-picker-search" autoFocus label="Search pull requests or paste a GitHub URL" placeholder="Search or paste a GitHub URL" value={query} onChange={setQuery} onKeyDown={e=>{if(e.key==='enter'){if(target)open(target);else if(!url&&matches[0])open(targetOf(matches[0].project,matches[0].pr))}}}/>
      {!data ? <PrLoading label="Loading pull requests…"/> : url ? target ? <Button testId="pr-picker-url" variant="primary" onClick={()=>open(target)}>{`Open #${target.number} · ${url.remote}`}</Button> : <div testId="pr-picker-unknown"><Label color={t.textSecondary}>This repository is not in your known projects, or its machine is offline. Add or reconnect its project first.</Label></div> : <virtual-list testId="pr-picker-results" estimatedItemHeight={58} style={{height:Math.min(348,Math.max(58,matches.length*58))}}>
        {matches.map(({project,pr})=><div key={`${project.id}/${pr.repo ?? ''}:${pr.number}`} role="button" tabIndex={0} testId={`pr-picker-${project.id}-${pr.repo ?? 'single'}-${pr.number}`} onClick={()=>open(targetOf(project,pr))} onKeyDown={e=>{if(e.key==='enter'||e.key==='space')open(targetOf(project,pr))}} style={{...column,gap:4,padding:10,borderRadius:8,hover:{backgroundColor:t.hover}}}><Label size={13} color={t.text} truncate>{`#${pr.number} ${pr.title}`}</Label><Label size={12} color={t.textSecondary} truncate>{`${project.name}${pr.repo ? ` / ${memberName(project,pr.repo)}`:''} · ${pr.state.toLowerCase()}`}</Label></div>)}
        {!matches.length&&<div key="empty" style={{padding:12}}><Label color={t.textSecondary}>No pull requests match this search.</Label></div>}
      </virtual-list>}
      {!!data?.errors.length&&<Label color={t.warning} size={12} style={{maxHeight:72}}>{data.errors.join('\n')}</Label>}
      <div style={{...row,justifyContent:'flex-end'}}><Button testId="pr-picker-cancel" onClick={onClose}>Cancel</Button></div>
    </div>
  </Dialog>
}
