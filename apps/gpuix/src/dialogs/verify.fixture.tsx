// Test-only renderer seam: never opens NSOpenPanel or browses the user's folders.
import '../native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { App } from '../App.tsx'
import { ThemeProvider } from '../ui.tsx'
import { connect, getClient } from '../state.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
const folder = process.env.KYBERN_VERIFY_PROJECT!
if (!folder?.includes('gpuix-scratch') || !process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Dialog fixture requires scratch paths')
// The remote branch uses the same scratch transport but daemon-side folder UI.
if (process.env.KYBERN_VERIFY_REMOTE === '1') Object.assign(activeEnvironment(), {local:false,name:'Scratch remote'})
connect()
function Fixture() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  const [prompts, setPrompts] = useState(0)
  const [added, setAdded] = useState(0)
  useEffect(() => {
    const client = getClient()!
    const call = client.call.bind(client)
    client.call = (async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'projects.browse') {
        const target = typeof params.path === 'string' ? params.path : folder
        if (!target.includes('gpuix-scratch')) throw Error('Fixture refuses user folders')
        return call('projects.browse', {path:target})
      }
      if (method === 'projects.add') {
        if (params.path !== folder) throw Error('Fixture only adds its scratch folder')
        const result = await call('projects.add', {path:folder})
        setAdded(n => n + 1)
        return result
      }
      return call(method as never, params as never)
    }) as typeof client.call
    const original = renderer.promptForPaths
    renderer.promptForPaths = async options => {
      if (!options?.directories || options?.files) throw Error('Expected directory-only picker')
      setPrompts(n => n + 1)
      return [folder]
    }
    setReady(true)
    return () => { renderer.promptForPaths = original; client.call = call }
  }, [renderer])
  return <div style={{display:'flex',width:'100%',height:'100%'}}>
    <text testId="fixture-prompt-calls" style={{position:'absolute',width:0,height:0,fontSize:1}}>{String(prompts)}</text>
    <text testId="fixture-project-adds" style={{position:'absolute',width:0,height:0,fontSize:1}}>{String(added)}</text>
    {ready && <App />}
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, {title:'Dialog verification',width:1280,height:820,focus:false,onKeyDown:onWindowKeyDown})
process.stdin.on('end', () => process.exit(0))
