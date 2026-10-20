// Copy image check: one button that puts the release artwork (PNG) on the
// pasteboard through `platform/files.ts` `copyImage` (the native patch's
// `writeClipboardImage`). verify.clipboard.ts saves and restores the user's
// clipboard around it.
import '../native/local-build.ts'
import { readFileSync } from 'node:fs'
import { render, useGpuixRequired } from '@gpuix/react'
import { useState } from 'react'
import { copyImage } from './files.ts'

const PNG = readFileSync(new URL('../../../desktop/public/release-background.png', import.meta.url))
function Lab() {
  const renderer = useGpuixRequired()
  const [state, setState] = useState('ready')
  return <div testId="app-ready" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 20, width: '100%', height: '100%', backgroundColor: '#202020' }}>
    <div testId="copy" onClick={() => { try { copyImage(renderer, PNG); setState('copied') } catch (e) { setState(String(e)) } }} style={{ padding: 10, backgroundColor: '#444' }}><text style={{ color: '#fff' }}>Copy image</text></div>
    <text testId={`state-${state}`} style={{ color: '#fff' }}>{state}</text>
  </div>
}
render(<Lab />, { title: 'Copy image check', width: 400, height: 200, focus: false })
