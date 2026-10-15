import os,pathlib,subprocess,json,time,signal
root=pathlib.Path(__file__).resolve().parents[1];os.chdir(root)
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/checks')
base='/Users/mymac/projects/ade-gpuix-native/apps/gpuix/packaging/'
commands=[
 ('src/split/native.verify.ts','full drag normal',['bun','scripts/audit-split.ts','--drag']),
 ('src/split/native.verify.ts','full drag reduced',['bun','scripts/audit-split.ts','--drag']),
 ('src/dock/verify-explorer.ts','isolated fixture',['bun','scripts/audit-explorer.ts']),
 ('src/dock/verify-artifact.ts','isolated fixture',['bun','scripts/audit-explorer.ts','src/dock/verify-artifact.ts']),
 ('src/environment/verify.ts','isolated git fixture',['bun','scripts/audit-explorer.ts','src/environment/verify.ts']),
 ('src/dock/verify-dock-check.ts','isolated git fixture',['bun','scripts/audit-explorer.ts','src/dock/verify-dock-check.ts']),
 ('src/environments/verify-qr.ts','isolated relocated fixture',['bun','scripts/audit-qr.ts']),
 ('src/environments/verify-memory.ts','isolated relocated fixture',['bun','scripts/audit-env-memory.ts']),
 ('src/environment/verify-performance.ts','isolated git fixture',['bun','scripts/audit-explorer.ts','scripts/audit-env-perf.ts']),
 ('src/requests/perf.verify.ts','isolated relocated fixture',['bun','scripts/audit-requests-perf.ts']),
 ('scripts/dock-project-check.ts','normal',['bun','scripts/audit-project-check.ts','--write']),
 ('scripts/dock-project-check.ts','reduced',['bun','scripts/audit-project-check.ts','--write']),
 ('src/shell/verify.native.ts','close-stop normal',['bun','src/shell/verify.native.ts','dark','--close','--stop']),
 ('src/shell/verify.native.ts','close-stop reduced',['bun','src/shell/verify.native.ts','dark','--close','--stop']),
 ('src/shell/verify.native.ts','theme normal',['bun','src/shell/verify.native.ts','--theme']),
 ('src/shell/verify.native.ts','theme reduced',['bun','src/shell/verify.native.ts','--theme']),
 ('src/shell/verify.persistence.ts','write/read',['bun','scripts/audit-persistence.ts']),
 ('scripts/audit-environments.ts','isolated fixtures',['bun','scripts/audit-environments.ts']),
 ('scripts/material-check.tsx','normal',['bun','scripts/material-check.tsx']),
 ('scripts/material-check.tsx','reduced',['bun','scripts/material-check.tsx']),
 ('scripts/audit-dock-probe.ts','main',['bun','scripts/audit-dock-probe.ts']),
 ('scripts/audit-dock-probe.ts','fixture',['bun','scripts/audit-dock-probe.ts','--fixture']),
 ('packaging/pointer-check.ts','existing bundle',['bun',base+'pointer-check.ts']),
 ('packaging/verify.ts','existing bundle',['bun',base+'verify.ts','bundle']),
 ('packaging/verify.ts','current source',['bun','packaging/verify.ts','source']),
 ('packaging/notification-check.ts','existing bundle',['bun',base+'notification-check.ts']),
]
results=json.loads((out/'extra-results.json').read_text()) if (out/'extra-results.json').exists() else []
completed={(r['file'],r['mode']) for r in results}
for file,mode,args in commands:
 if (file,mode) in completed:continue
 if file=='src/split/native.verify.ts':
  earlier=json.loads((out/'results.json').read_text())
  originalMode='reduced' if 'reduced' in mode else 'normal'
  if any(r['file']==file and r['mode']==originalMode and r['status']=='Pass' for r in earlier):continue
 name=file.replace('/','__')+'.'+mode.replace(' ','-').replace('/','-');log=out/(name+'.log')
 env=os.environ.copy();env.update(NAPI_RS_NATIVE_LIBRARY_PATH=str(root/'native/build/gpuix-native.darwin-arm64.node'),KYBERN_REDUCED_MOTION='1' if 'reduced' in mode else '0',KYBERN_DEBUG_MATERIAL='1',GPUIX_BACKGROUND='1',KYBERN_VERIFY_OUTPUT=str(out/name))
 cmd=['bun','src/transcript/scratch.verify.ts',*args];start=time.monotonic()
 with log.open('w')as f:
  p=subprocess.Popen(cmd,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=900 if file=='src/split/native.verify.ts' else 540 if 'audit-environments' in file else 180)
  except subprocess.TimeoutExpired:code=124
  try:os.killpg(p.pid,signal.SIGTERM)
  except OSError:pass
 tail=log.read_text(errors='replace')[-2200:]
 status='Pass' if code==0 else 'Timeout' if code==124 else 'Fail'
 if code==0 and file.endswith('audit-dock-probe.ts'):status='Completed diagnostic (no assertions)'
 if code==0 and file.endswith('material-check.tsx'):status='Pass (material probe)' if 'material=21' in tail else 'Inconclusive material probe'
 if code==0 and file.endswith('notification-check.ts') and '[notification click]' not in tail:status='Partial: no click observed'
 results.append(dict(file=file,mode=mode,status=status,exit=code,command=cmd,seconds=round(time.monotonic()-start,1),log=str(log),tail=tail))
 (out/'extra-results.json').write_text(json.dumps(results,indent=2));print(file,mode,status,flush=True)
