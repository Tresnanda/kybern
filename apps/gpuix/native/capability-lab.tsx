import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { nativeCapabilities } from '../src/native/api.ts'

function Lab() {
  const renderer = useGpuixRequired()
  const api = nativeCapabilities(renderer)
  const [value, setValue] = useState('a😀é example')
  const [tick, setTick] = useState(0)
  const [result, setResult] = useState('')
  const [font, setFont] = useState('Helvetica')
  const id = (testId: string) => {
    const tree = JSON.parse((renderer as unknown as { getAutomationTree(): string }).getAutomationTree())
    const find = (node: any): number | undefined => node.testId === testId || node.props?.testId === testId ? node.id : node.children?.map(find).find((id: number | undefined) => id != null)
    const found = (Array.isArray(tree) ? tree.map(find).find((id: number | undefined) => id != null) : find(tree))
    if (found == null) throw Error(`Missing ${testId}: ${JSON.stringify(tree).slice(0, 200)}`)
    return found
  }
  const action = (testId: string, callback: () => unknown) => <div testId={testId} onClick={() => {
    try { setResult(JSON.stringify(callback()) ?? 'ok') } catch (error) { setResult(String(error)) }
  }} style={{ width: 250, height: 26, backgroundColor: '#666666' }}><text>{testId}</text></div>
  return <div testId="app-ready" onKeyDown={e => { if (e.key === 'x') { setTick(n => n + 1); setResult(JSON.stringify(api.getTextSelection())) } }} style={{ width: '100%', height: '100%', backgroundColor: process.env.KYBERN_APPEARANCE === 'light' ? '#eeeeee' : '#202020', color: '#b05050', display: 'flex', flexDirection: 'column', gap: 4 }}>
    <textarea testId="editor" value={value} onChange={e => setValue(e.value ?? '')} style={{ width: 400, height: 70 }} />
    <text testId="value">{value}</text>
    {action('select-input', () => { api.setInputSelection(id('editor'), 1, 4, true); return api.getInputSelection(id('editor')) })}
    {action('edit-input', () => api.editInput(id('editor'), { start: 1, end: 4, text: '**😀é**', expectedValue: value }))}
    {action('stale-edit', () => api.editInput(id('editor'), { start: 0, end: 1, text: 'X', expectedValue: 'stale' }))}
    {action('bad-boundary', () => api.setInputSelection(id('editor'), 2, 3, false))}
    {action('load-fonts', () => { for (const font of ['CalSans', 'JetBrainsMono']) api.registerFont(readFileSync(new URL(`../src/assets/fonts/${font}-Regular.ttf`, import.meta.url))); setFont('Cal Sans') })}
    <text testId="font-sample" style={{ fontFamily: font, fontSize: 32, alignSelf: 'flex-start' }}>Hamburgefonts 012345</text>
    <div cache style={{ width: 400, height: 40 }}><text testId="prose" style={{ fontSize: 18 }}>Replay 😀 selection</text></div>
    {action('select-prose', () => { api.setTextSelection(id('prose'), 0, 7, 9); return api.getTextSelection() })}
    {action('inspect-prose', () => api.getTextSelection())}
    {action('scroll-list', () => renderer.scrollToItem!(id('list'), 30))}
    {action('outside-tick', () => setTick(n => n + 1))}
    <text>{`Tick ${tick}`}</text>
    <text testId="result">{result}</text>
    <virtual-list testId="list" estimatedItemHeight={28} style={{ width: 400, height: 200 }}>
      {Array.from({length: 40}, (_, n) => <div key={n} style={{ display: 'flex' }}><div cache testId={`row-${n}`} style={{ width: '100%', height: 28 }}><text>{`Row ${n} tick ${tick}`}</text></div></div>)}
    </virtual-list>
  </div>
}
render(<Lab />, { title: 'Native selection and font check', width: 700, height: 900, focus: false })
