import {memo, useMemo, useState} from 'react'
import type {DiffProps} from '@gpuix/react'
import {parseUnifiedDiff} from '../../../desktop/src/lib/diff.ts'
import {getFileIconName} from '../../../desktop/src/lib/kit/fileIcons.ts'
import {Icon} from '../icons.tsx'
import {Chevron} from '../sidebar/rows.tsx'
import {Label, useTheme} from '../ui.tsx'
import {alpha} from '../transcript/kit.tsx'
import {desktopDiffTheme} from './diff.ts'
import {diffFileIcons} from './diff-file-icons.ts'

export interface DiffHeaderFile {path:string;oldPath?:string|null;status?:string;additions:number;deletions:number}
export { colors as fileIconColors }
const colors:Record<string,string>={audio:'#38bdf8','calendar-days':'#f59e0b',cmd:'#4ade80','code-brackets':'#9ca3af','file-jpg':'#22c55e','file-pdf':'#ef4444','file-png':'#22c55e','file-text':'#94a3b8','file-zip':'#f97316','page-text':'#94a3b8','image-alt-text':'#22c55e',lock:'#f59e0b','settings-gear-1':'#a78bfa',video:'#c084fc',typescript:'#3178c6',markdown:'#6cb6ff',javascript:'#f7df1e',react:'#61dafb',json:'#f5c542',rust:'#dea584',phyton:'#3776ab',git:'#f05032',npm:'#cb3837',bun:'#f4d7a1',java:'#f89820',php:'#777bb4',c:'#659ad2',vue:'#42b883',svelte:'#ff3e00'}
/** Desktop FileDiffHeader geometry; the header stays outside horizontal scrolling. */
export function NativeDiffHeader({file,open,onToggle,testId}:{file:DiffHeaderFile;open?:boolean;onToggle?:()=>void;testId?:string}) {
 const t=useTheme(),name=file.path.split('/').pop()??file.path,dir=file.path.slice(0,file.path.length-name.length),kind=getFileIconName(file.path)
 return <div testId={testId} aria-label={file.path} role={onToggle?'button':undefined} tabIndex={onToggle?0:undefined} onClick={onToggle} onKeyDown={e=>{if(e.key==='enter'||e.key==='space')onToggle?.()}} style={{display:'flex',alignItems:'center',gap:8,height:30.25,flexShrink:0,paddingLeft:10,paddingRight:10,borderBottomWidth:1,borderColor:t.border,backgroundColor:t.v('--background'),cursor:onToggle?'pointer':'default'}}>
 {onToggle&&<Chevron open={!!open} size={14} color={alpha(t.textSecondary,0.5)}/>}
 <div style={{width:16,height:16,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}><Icon source={diffFileIcons[kind]??diffFileIcons['code-brackets']!} size={14} color={colors[kind]??alpha(t.textSecondary,0.6)}/></div>
 {file.oldPath&&<><Label size={11.5} color={alpha(t.textSecondary,0.65)} style={{textDecoration:'line-through'}}>{file.oldPath.split('/').pop()}</Label><Label size={11} color={alpha(t.textSecondary,0.45)}>→</Label></>}
 <Label size={11.5} weight={500} color={alpha(t.text,0.85)}>{name}</Label>
 <Label size={11} color={alpha(t.textSecondary,0.55)} truncate style={{minWidth:0,flexShrink:1}}>{dir}</Label>
 {(file.status==='added'||file.status==='deleted')&&<Label size={10} color={t.textSecondary} style={{borderRadius:20,paddingLeft:6,paddingRight:6,backgroundColor:t.v('--color-background-elevated-secondary')}}>{file.status==='added'?'new':'deleted'}</Label>}
 <div style={{flexGrow:1}}/>
 <div style={{display:'flex',gap:6,flexShrink:0}}><Label size={10} color={t.v('--color-decoration-added')}>{`+${file.additions}`}</Label><Label size={10} color={t.v('--color-decoration-deleted')}>{`-${file.deletions}`}</Label></div>
 </div>
}

type Props = Omit<DiffProps,'theme'|'wordDiff'|'collapsedPaths'|'onToggleFile'>
/** Native body rows stay virtualized above 600 lines. Original patches and
 * onLineClick events pass through unchanged. Each file has an independent header. */
export const DesktopDiff = memo(function DesktopDiff({patch='',style,testId,scroll,...props}:Props) {
 const chunks=useMemo(()=>patch.split(/(?=^diff --git )/m).filter(Boolean).map(text=>({text,file:parseUnifiedDiff(text.replace(/\n$/, ''))[0]})),[patch])
 return <div style={{display:'flex',flexDirection:'column',minWidth:0,...style}}>
 {chunks.map(({text,file},i)=>file?<DiffCard key={file.path} patch={text} file={file} testId={i&&testId?`${testId}-${i}`:testId} forceScroll={!!scroll} {...props}/>:<diff key={i} patch={text} testId={testId} {...props}/>)}
 </div>
})
function DiffCard({file,patch,forceScroll,maxLines,onShowMore,...props}:Omit<Props,'scroll'|'style'> & {file:ReturnType<typeof parseUnifiedDiff>[number];forceScroll:boolean}) {
 const t=useTheme(),[open,setOpen]=useState(true),[visible,setVisible]=useState(600)
 const count=file.hunks.reduce((n,h)=>n+h.lines.length,0),bounded=forceScroll||count>600
 const theme=useMemo(()=>desktopDiffTheme(t,false),[t])
 return <div style={{display:'flex',flexDirection:'column',flexShrink:0,minWidth:0,borderWidth:1,borderColor:t.border,borderRadius:6,overflow:'hidden'}}>
 <NativeDiffHeader file={file} open={open} onToggle={()=>setOpen(!open)} testId={`diff-header-${file.path}`}/>
 {open&&(file.binary?<Label size={11} color={alpha(t.textSecondary,0.75)} style={{padding:12}}>Binary file changed.</Label>:!file.hunks.length?<Label size={11} color={alpha(t.textSecondary,0.75)} style={{padding:12}}>No textual changes.</Label>:<diff {...props} patch={patch} maxLines={maxLines??visible} onShowMore={e=>{setVisible(n=>n+600);onShowMore?.(e)}} theme={theme} scroll={bounded} style={bounded?{height:Math.min(360,count*21.45+file.hunks.length*25.45),minWidth:0}:{minWidth:0}}/>)}
 </div>
}
