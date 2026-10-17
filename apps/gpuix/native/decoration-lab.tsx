import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useState } from 'react'
import { DecoratedTextarea } from '../src/native/decorated-input.tsx'
import { nativeCapabilities, decoratedInputCapabilities } from '../src/native/api.ts'
const initial = 'Hello @Computer 😀 bold italic code link end'
function Lab() {
  const renderer = useGpuixRequired(), api = nativeCapabilities(renderer), rich = decoratedInputCapabilities(renderer)
  const [value, setValue] = useState(initial), [result, setResult] = useState(''), [tick, setTick] = useState(0)
  const id = (testId: string): number => {
    const tree = JSON.parse((renderer as any).getAutomationTree())
    const find = (n: any): any => n.testId === testId || n.props?.testId === testId ? n.id : n.children?.map(find).find((v: any) => v != null)
    return Array.isArray(tree) ? tree.map(find).find((v: any) => v != null) : find(tree)
  }
  const light = process.env.KYBERN_APPEARANCE === 'light'
  const decorations = [
    { start: 6, end: 15, atomic: true, id: 'computer', style: { color: light ? '#134e95' : '#b5d8ff', backgroundColor: light ? '#c8e1ff' : '#244263', fontWeight: 600 } },
    { start: 19, end: 23, style: { fontWeight: 700 } },
    { start: 24, end: 30, style: { fontStyle: 'italic' as const } },
    { start: 31, end: 35, style: { backgroundColor: light ? '#dddde4' : '#40404a' } },
    { start: 36, end: 40, id: 'link', style: { underline: true, color: light ? '#165cb0' : '#8abaff' } },
  ]
  const button = (name: string, fn: () => unknown) => <div testId={name} onClick={() => { try { setResult(JSON.stringify(fn()) ?? 'ok') } catch (e) { setResult(String(e)) } }} style={{ width: 200, height: 28, backgroundColor: light ? '#dddddd' : '#444444' }}><text style={{ color: light ? '#111111' : '#eeeeee' }}>{name}</text></div>
  return <div testId="app-ready" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 6, backgroundColor: light ? '#fafafa' : '#202024' }}>
    <div cache="fill" style={{ width: 600, height: 90 }}><textarea testId="editor" value={value} onChange={e => setValue(e.value ?? '')} style={{ width: 580, height: 86, fontSize: 18, color: light ? '#181818' : '#eeeeee' }} /></div>
    <DecoratedTextarea testId="adapter" value="Use @Computer now" decorations={[{ start: 4, end: 13, atomic: true, style: { fontWeight: 700, backgroundColor: light ? '#c8e1ff' : '#244263' } }]} style={{ width: 580, height: 36, color: light ? '#181818' : '#eeeeee' }} />
    <text testId="value" style={{ color: light ? '#111111' : '#eeeeee' }}>{value}</text>
    {button('decorate', () => rich.setInputDecorations(id('editor'), decorations, value))}
    {button('select-before', () => api.setInputSelection(id('editor'), 6, 6, false))}
    {button('select-inside', () => { api.setInputSelection(id('editor'), 9, 9, false); return api.getInputSelection(id('editor')) })}
    {button('selection', () => api.getInputSelection(id('editor')))}
    {button('insert-prefix', () => api.editInput(id('editor'), { start: 0, end: 0, text: '😀', expectedValue: value }))}
    {button('replace-inside', () => api.editInput(id('editor'), { start: 8, end: 10, text: 'X', expectedValue: value }))}
    {button('bad-range', () => rich.setInputDecorations(id('editor'), [{ start: 17, end: 18 }], value))}
    {button('stale', () => rich.setInputDecorations(id('editor'), decorations, 'stale'))}
    {button('unsupported', () => rich.setInputDecorations(id('editor'), [{ start: 0, end: 2, style: { paddingX: 3 } } as any], value))}
    {button('adapter-selection', () => { api.setInputSelection(id('adapter'), 7, 7, false); return api.getInputSelection(id('adapter')) })}
    {button('hit-test', () => { const b = renderer.getElementBounds!(id('editor'))!; return [...new Set(Array.from({ length: Math.floor(b.width) }, (_, x) => rich.hitTestInputDecoration(id('editor'), b.x + x, b.y + 12)).filter(Boolean))] })}
    {button('scroll', () => (renderer as any).scrollToItem(id('list'), 35))}
    {button('scroll-top', () => (renderer as any).getListScrollTop(id('list')))}
    {button('tick', () => setTick(tick + 1))}
    <text style={{ color: light ? '#111111' : '#eeeeee' }}>{`Tick ${tick}`}</text>
    <text testId="result" style={{ color: light ? '#111111' : '#eeeeee' }}>{result}</text>
    <div cache="fill" style={{ width: 600, height: 150 }}><div cache style={{ width: 600, height: 150 }}>
      <virtual-list testId="list" estimatedItemHeight={28} style={{ width: 600, height: 150 }}>
        {Array.from({ length: 48 }, (_, n) => <div key={n} testId={`row-${n}`} style={{ height: 28 }}><text style={{ color: light ? '#111111' : '#eeeeee' }}>{`Cached row ${n}`}</text></div>)}
      </virtual-list>
    </div></div>
  </div>
}
render(<Lab />, { title: 'Decorated native input and cached scrolling', width: 720, height: 980, focus: false })
