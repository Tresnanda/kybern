import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useRef, useState } from 'react'
import { observeElementBounds, type ElementBoundsEvent } from '../src/native/layout.ts'

const patch = (prefix: string, count = 1000) => `diff --git a/${prefix}.txt b/${prefix}.txt
--- a/${prefix}.txt
+++ b/${prefix}.txt
@@ -1,${count} +1,${count} @@
${Array.from({length: count}, (_, i) => ` ${prefix} row ${i}`).join('\n')}
`
function Lab() {
  const renderer = useGpuixRequired()
  const [shown, setShown] = useState(true), [generation, setGeneration] = useState(0)
  const [rows, setRows] = useState(1000), [scroll, setScroll] = useState(true), [result, setResult] = useState('')
  const saved = useRef<number[] | null>(null), oldId = useRef<number | null>(null)
  const events = useRef<ElementBoundsEvent[]>([]), stop = useRef<(() => void) | null>(null)
  const id = (testId: string): number => {
    const tree = JSON.parse((renderer as any).getAutomationTree())
    const find = (node: any): number | undefined => node.testId === testId || node.props?.testId === testId ? node.id : node.children?.map(find).find((n: number | undefined) => n != null)
    const value = Array.isArray(tree) ? tree.map(find).find((n: number | undefined) => n != null) : find(tree)
    if (value == null) throw Error(`Missing ${testId}`)
    return value
  }
  const inspect = () => ({a: shown ? renderer.getListScrollTop?.(id('diff-a')) : null, b: renderer.getListScrollTop?.(id('diff-b')), list: renderer.getListScrollTop?.(id('list')), saved: saved.current, old: oldId.current == null ? null : renderer.getListScrollTop?.(oldId.current), id: shown ? id('diff-a') : null, events: events.current.slice(-12), raw: renderer.getListScrollTop?.(900000)})
  const raw = (mount: boolean) => {
    const batch = mount ? [['createElement', 900000, 'diff'], ['setCustomProp', 900000, 'patch', patch('raw')], ['setCustomProp', 900000, 'scroll', true], ['setStyle', 900000, {width: 280, height: 180}], ['appendChild', id('raw-slot'), 900000]] : [['destroyElement', 900000]]
    renderer.applyBatch(JSON.stringify(batch))
  }
  const action = (key: string) => {
    try {
      if (key === 'o') { stop.current?.(); events.current = []; stop.current = observeElementBounds(renderer, {testId: 'diff-a'}, e => events.current.push(e)) }
      else if (key === 's') { oldId.current = id('diff-a'); saved.current = renderer.getListScrollTop?.(oldId.current) ?? null }
      else if (key === 'h') setShown(false)
      else if (key === 'm') { setGeneration(n => n + 1); setShown(true) }
      else if (key === 'r') { if (!saved.current) throw Error('No saved anchor'); renderer.scrollToItem?.(id('diff-a'), saved.current[0]!, saved.current[1]!) }
      else if (key === 'j') renderer.scrollToItem?.(id('diff-a'), 320, 7.25)
      else if (key === 'b') renderer.scrollToItem?.(id('diff-b'), 640, 3.5)
      else if (key === 'l') renderer.scrollToItem?.(id('list'), 48, 5.5)
      else if (key === 'd') { setRows(800); renderer.scrollToItem?.(id('diff-a'), 410, 9.5) }
      else if (key === 'c') setRows(50)
      else if (key === 'e') setRows(0)
      else if (key === 'f') setScroll(false)
      else if (key === 'v') { setRows(1000); setScroll(true) }
      else if (key === 'x') raw(true)
      else if (key === 'y') raw(false)
      else if (key === 'z') renderer.scrollToItem?.(900000, 240, 4.5)
      else if (key === 'i') setResult(JSON.stringify(inspect()))
    } catch (error) { setResult(String(error)) }
  }
  return <div testId="ready" onKeyDown={e => action(e.key ?? '')} style={{width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#202024', color: '#eeeeee'}}>
    <div style={{display: 'flex', height: 350, flexShrink: 0}}>
      <div cache="fill" style={{width: 360, height: 350}}><div cache style={{width: 360, height: 350}}>
        {shown && <diff key={generation} testId="diff-a" patch={rows ? patch('alpha', rows) : ''} scroll={scroll} cacheLayout style={{width: 360, height: 350, overflow: 'hidden'}} />}
      </div></div>
      <diff testId="diff-b" patch={patch('beta')} scroll cacheLayout style={{width: 360, height: 350}} />
    </div>
    <virtual-list testId="list" estimatedItemHeight={24} style={{width: 360, height: 100, flexShrink: 0}}>
      {Array.from({length: 100}, (_, i) => <div key={i} style={{height: 24}}><text>{`ordinary row ${i}`}</text></div>)}
    </virtual-list>
    <div testId="raw-slot" style={{width: 280, height: 180, flexShrink: 0}} />
    <text testId="result" style={{fontSize: 9, height: 100}}>{result}</text>
  </div>
}
render(<Lab />, {title: 'Exact diff scroll anchors', width: 740, height: 780, focus: false})
