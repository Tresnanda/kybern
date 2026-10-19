// Test-only full-app controls. Product components and input routes are unchanged.
import { readFileSync } from 'node:fs'
Bun.plugin({name:'hr5-order-baseline',setup(build){
 build.onLoad({filter:/\/src\/(state\.ts|shell\/Connection\.tsx|nav\/overlay\.tsx|transcript\/images\.tsx)$/},args=>{
  const relative=args.path.slice(args.path.indexOf('/apps/gpuix/src/')+'/apps/gpuix/src/'.length)
  const file=process.env.HR5_ORDER_BASELINE==='1'?'/Users/mymac/projects/ade-gpuix-scratch/hr5-order-baseline-source/'+relative:args.path
  return {contents:readFileSync(file,'utf8'),loader:args.path.endsWith('.tsx')?'tsx':'ts'}
 })
}})
Bun.plugin({name:'hr5-order-controls',setup(build){
  build.onLoad({filter:/\/src\/Transcript\.tsx$/},args=>{
    const source=readFileSync(args.path,'utf8'),anchor='  // A message the reader just sent'
    if(!source.includes(anchor))throw Error('Transcript fixture anchor moved')
    const traced=source.replace('    renderer.focusElement?.(elementId)', '    ;(globalThis as any).__orderFocus={elementId,anchor,node:node?.id};renderer.focusElement?.(elementId)').replace('    if (node && anchor) renderer.scrollToItem?.(node.id, anchor[0]!, anchor[1]!)', '    if (node && anchor) { try { renderer.scrollToItem?.(node.id, anchor[0]!, anchor[1]!);(globalThis as any).__orderFocus.restored=true } catch(error) { (globalThis as any).__orderFocus.error=String(error);throw error } }')
    return {loader:'tsx',contents:traced.replace(anchor,`  ;(globalThis as any).__orderKey=()=>{const a=list.current&&renderer.getListScrollTop?.(list.current.id);return a?logicalKeys[a[0]!]??'__end':null}
    ;(globalThis as any).__orderJump=(id:string)=>{
      const index=rows.findIndex(row=>row.turn.user?.id===id)
      if(index<0||!list.current)throw Error('Missing image row')
      mountWindow.reveal(index);renderer.scrollToItem?.(list.current.id,index+lead,0)
    }
`+anchor)}
  })
  build.onLoad({filter:/\/perf\/bench\/app\.ts$/},args=>{
    const source=readFileSync(args.path,'utf8'),anchor=" if(body.action==='counters'){"
    if(!source.includes(anchor))throw Error('Benchmark control anchor moved')
    return {loader:'ts',contents:source.replace(anchor,` if(body.action==='tail-grow'){
      const s=state.getState(),last=[...s.open.blocks].reverse().find(b=>b.kind==='assistant')!
      state.setThreadOpen(s.selectedId!,{...s.open,blocks:s.open.blocks.map(b=>b===last&&b.kind==='assistant'?{...b,text:b.text+'\\n\\nTail growth preserves following.'}:b)})
      return Response.json({grown:true})
    }
    if(body.action==='prepare-images'){
      const s=state.getState(),last=[...s.open.blocks].reverse().find(b=>b.kind==='user')!,sample=s.open.blocks.find(b=>b.kind==='user'&&b.message.parts.some(p=>p.type==='image'))!
      let image=sample.kind==='user'?sample.message.parts.find(p=>p.type==='image')!:null
      if(process.env.HR5_ORDER_LARGE_IMAGES==='1')image={type:'image',media_type:'image/png',data:(await import('node:fs')).readFileSync(path.join(process.env.KYBERN_DATA_DIR!,'projects/project-00/fixture.png')).toString('base64')}
      state.setThreadOpen(s.selectedId!,{...s.open,blocks:s.open.blocks.map(b=>b.kind==='user'?{...b,message:{parts:[...b.message.parts.map(p=>p.type==='image'?image:p),...(b===last?[image]:[])]}}:b.kind==='assistant'&&b.turnId===last.turnId?{...b,text:'Final answer. Preserve the reading position.'}:b) as any})
      return Response.json({prepared:true})
    }
    if(body.action==='position'){(globalThis as any).__orderJump(body.target);return Response.json({positioned:true})}
    if(body.action==='reading'){
      const root=(globalThis as any).__benchFiberRoot,renderer=root?.containerInfo?.nativeRenderer
      const tree=JSON.parse(renderer.getAutomationTree()),nodes:any[]=[]
      const visit=(n:any)=>{if(Array.isArray(n)){n.forEach(visit);return}nodes.push(n);(n.children??[]).forEach(visit)};visit(tree)
      const list=nodes.find(n=>n.testId==='transcript')
      return Response.json({topKey:(globalThis as any).__orderKey?.(),streamDeltas,restoration:(globalThis as any).__orderFocus,anchor:list&&renderer.getListScrollTop(list.id),list:list?.id,focus:renderer.getFocusedElementId?.(),tail:nodes.find(n=>n.testId?.startsWith('transcript-bottom:'))?.bounds,images:state.getState().open.blocks.filter(b=>b.kind==='user'&&b.message.parts.some(p=>p.type==='image')).map(b=>b.id),rows:nodes.filter(n=>n.testId?.startsWith('turn-user:')).map(n=>({id:n.id,testId:n.testId,bounds:n.bounds}))})
    }
`+anchor)}
  })
}})
await import('../../bench/app.ts')
