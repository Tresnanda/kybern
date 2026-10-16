import { useState } from 'react'
import { homedir } from 'node:os'
import path from 'node:path'
import { bundledCommand, desktopVersion } from '../shell/daemon.ts'
import { checkRelease, cliStatus, installCli, uninstallCli } from '../shell/platform.ts'
import { Button, Row, Section, TextField } from './controls.tsx'
import { useResource } from './resource.ts'
import { openUrl } from '../pulls/PrStates.tsx'

export function About() {
 const info=useResource('daemon.info',{})
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 const [version]=useState(desktopVersion)
 const [bundled,setBundled]=useState(()=>bundledCommand('kybern')??'')
 const [target,setTarget]=useState(()=>{
   const local=path.join(homedir(),'.local/bin')
   return path.join((process.env.PATH??'').split(path.delimiter).includes(local)||process.platform!=='darwin'?local:'/usr/local/bin','kybern')
 }),[cliMessage,setCliMessage]=useState('')
 const [status,setStatus]=useState<Awaited<ReturnType<typeof cliStatus>>|null>(null)
 const check=async()=>{setBusy(true);try{const release=await checkRelease(version);setMessage(release.newer?`Version ${release.version} is available. GPUIX does not yet ship a signed updater. Open Releases to choose a compatible desktop download.`:'You’re up to date.')}catch(e){setMessage(String(e))}finally{setBusy(false)}}
 const cli=async(action:'check'|'install'|'uninstall')=>{setBusy(true);setCliMessage('');try{const paths={bundled,target};if(action==='install')await installCli(paths);if(action==='uninstall')await uninstallCli(paths);const next=await cliStatus(paths);setStatus(next);setCliMessage(next.installed?'Command installed.':next.occupied?'Another command occupies this path. Choose another location.':'Ready to install the command at this path.')}catch(e){setCliMessage(String(e));setStatus(null)}finally{setBusy(false)}}
 return <><Section title="About"><Row title="Kybern" description={`GPUIX preview · ${version}`}><Button testId="about-check-update" disabled={busy} onClick={()=>void check()}>Check for updates</Button></Row>{message&&<Row title="Updates" description={message}><Button onClick={()=>openUrl('https://github.com/Tresnanda/kybern/releases')}>Open Releases</Button></Row>}<Row title="Daemon" description={info.data?.version??'…'}/><Row title="Protocol" description={info.data?String(info.data.protocol_version):'…'}/><Row title="Host" description={info.data?`${info.data.hostname} · ${info.data.os} ${info.data.arch}`:'…'}/><Row title="Data" description={info.data?.data_dir??info.error??'…'}/></Section>
 <Section title="Command line"><Row title="Bundled command" description="Select the absolute path to the kybern executable supplied with your installation."><TextField testId="cli-bundled" label="Bundled command path" value={bundled} onChange={v=>{setBundled(v);setStatus(null)}}/></Row><Row title="Install location" description="Use an absolute path in a folder already on your PATH. Existing commands are never overwritten."><TextField testId="cli-target" label="Command installation path" value={target} onChange={v=>{setTarget(v);setStatus(null)}}/></Row><Row title="Terminal command" description={cliMessage||'Check the paths before installing.'}><Button testId="cli-check" disabled={busy||!bundled||!target} onClick={()=>void cli('check')}>Check paths</Button>{status&&<Button testId="cli-install" disabled={busy||(!status.installed&&status.occupied)} onClick={()=>void cli(status.installed?'uninstall':'install')}>{status.installed?'Uninstall command':'Install command'}</Button>}</Row></Section></>
}
