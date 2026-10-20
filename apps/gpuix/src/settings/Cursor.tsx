import { useEffect, useRef, useState } from 'react'
import type { CursorSetupAction, CursorSetupStatus } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { loadProviders } from '../nav/live.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { Button, Row, Section } from './controls.tsx'

export function CursorSetup() {
 const [status,setStatus]=useState<CursorSetupStatus|null>(null)
 const [busy,setBusy]=useState(false), [error,setError]=useState('')
 const opened=useRef('')
 const client=getClient()
 const apply=(next:CursorSetupStatus)=>{setStatus(next);if(next.signing_in&&next.login_url&&opened.current!==next.login_url){opened.current=next.login_url;openUrl(next.login_url)}}
 const waiting=!!(status?.installing||status?.signing_in)
 useEffect(()=>{
  let live=true;let timer:ReturnType<typeof setTimeout>
  const poll=async()=>{try{const next=await client!.call('cursor.status',{});if(!live)return;apply(next);if(next.installing||next.signing_in)timer=setTimeout(()=>void poll(),1500);else if(waiting)void loadProviders(true)}catch(e){if(live)setError(String(e))}}
  void poll();return()=>{live=false;clearTimeout(timer)}
 },[client,waiting])
 const act=async(action:CursorSetupAction)=>{setBusy(true);setError('');try{const next=await client!.call('cursor.setup',{action});if(client!==getClient())return;apply(next);if(!next.installing&&!next.signing_in)await loadProviders(true)}catch(e){setError(`Unable to complete Cursor setup. ${String(e)}`)}finally{setBusy(false)}}
 return <Section title="Cursor SDK"><Row title={status?.installed?`SDK ${status.sdk_version}`:'Cursor'} description={error||status?.error||status?.problem||(status?.installing?'Installing Cursor’s SDK…':status?.signing_in?'Finish signing in in your browser. This page updates when you’re done.':status?.email?`Signed in as ${status.email}`:status?.account==='api_key'?'Signed in with CURSOR_API_KEY.':'Cursor’s SDK installs separately from the Cursor app.')}>
 {!status?<Button disabled onClick={()=>{}}>Checking…</Button>:status.installing?<Button disabled onClick={()=>{}}>Installing…</Button>:!status.installed?<Button testId="cursor-install" disabled={busy||!!status.problem} onClick={()=>void act('install')}>Install SDK</Button>:status.signing_in?<><Button disabled={!status.login_url} onClick={()=>status.login_url&&openUrl(status.login_url)}>Open sign-in page</Button><Button testId="cursor-cancel" disabled={busy} onClick={()=>void act('cancel_sign_in')}>Cancel</Button></>:status.account==='signed_in'?<Button testId="cursor-sign-out" disabled={busy} onClick={()=>void act('sign_out')}>Sign out</Button>:status.account!=='api_key'?<Button testId="cursor-sign-in" disabled={busy} onClick={()=>void act('sign_in')}>Sign in</Button>:null}
 <Button testId="cursor-check" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{apply(await client!.call('cursor.status',{}));await loadProviders(true)}catch(e){setError(String(e))}finally{setBusy(false)}}}>Check again</Button></Row></Section>
}
