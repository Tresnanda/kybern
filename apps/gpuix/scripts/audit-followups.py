import pathlib,subprocess,os,json,time,signal
root=pathlib.Path(__file__).resolve().parents[1];out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/checks')
commands=[('scripts/env-isolation-check.ts','isolated normal and reduced',['bun','scripts/audit-environments.ts','--isolation-only']),('src/requests/perf.verify.ts','current secret label',['bun','scripts/audit-requests-perf.ts']),('scripts/dock-project-check.ts','coordinator normal',['bun','scripts/audit-project-fixture.ts']),('scripts/dock-project-check.ts','coordinator reduced',['bun','scripts/audit-project-fixture.ts']),('src/dock/verify-explorer.ts','isolated reduced',['bun','scripts/audit-explorer.ts']),('src/environment/verify.ts','isolated git reduced',['bun','scripts/audit-explorer.ts','src/environment/verify.ts']),('src/dock/verify-dock-check.ts','isolated git reduced',['bun','scripts/audit-explorer.ts','src/dock/verify-dock-check.ts']),('src/environments/verify-qr.ts','corrected isolated CLI environment',['bun','scripts/audit-qr.ts'])]
results=[]
for file,mode,args in commands:
 log=out/(file.replace('/','__')+'.'+mode.replace(' ','-')+'.log');env=os.environ.copy();env.update(GPUIX_BACKGROUND='1',KYBERN_REDUCED_MOTION='1' if 'reduced' in mode else '0',NAPI_RS_NATIVE_LIBRARY_PATH=str(root/'native/build/gpuix-native.darwin-arm64.node'),KYBERN_VERIFY_OUTPUT=str(out/(file.replace('/','__')+'-followup')))
 start=time.monotonic();cmd=['bun','src/transcript/scratch.verify.ts',*args]
 with log.open('w') as f:
  p=subprocess.Popen(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=180)
  except subprocess.TimeoutExpired:code=124
  try:os.killpg(p.pid,signal.SIGTERM)
  except OSError:pass
 r=dict(file=file,mode=mode,status='Pass' if code==0 else 'Timeout' if code==124 else 'Fail',exit=code,command=cmd,seconds=round(time.monotonic()-start,2),log=str(log),tail=log.read_text(errors='replace')[-2200:]);results.append(r);(out/'followup-results.json').write_text(json.dumps(results,indent=2));print('FOLLOWUP',file,mode,r['status'],flush=True)
