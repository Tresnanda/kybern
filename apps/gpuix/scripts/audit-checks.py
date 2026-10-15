#!/usr/bin/env python3
"""Sequential audit runner. Fresh installed-binary scratch fixture per check.
Run after visual captures. No dependency install or native rebuild.
"""
import glob,json,os,pathlib,signal,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[1]
os.chdir(ROOT)
OUT=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/checks')
OUT.mkdir(parents=True,exist_ok=True)
files=sorted(set(glob.glob('scripts/*check*.ts')+glob.glob('src/**/verify*.ts',recursive=True)+glob.glob('src/**/*.verify.ts',recursive=True)+glob.glob('native/*check*.ts')))
files=[file for file in files if not pathlib.Path(file).name.startswith('audit-')]
skip={
 'scripts/env-isolation-check.ts':'Hardcoded reserved port-4219 data directory; cannot run safely unchanged.',
 'scripts/dock-project-check.ts':'Requires exact reserved port-4219 data directory; cannot run safely unchanged.',
 'src/requests/live.verify.ts':'Hardcoded reserved daemon and requires a live provider request.',
 'src/environment/verify-performance.ts':'Hardcoded reserved daemon/thread.',
 'src/environments/verify-qr.ts':'Hardcoded unrelated environments-second daemon; does not accept isolation override.',
 'src/environments/verify-memory.ts':'Requires historical two-environment fixture, not a standalone check.',
 'src/environments/verify.ts':'Requires historical two-environment fixture and IDs.',
 'src/dialogs/verify.ts':'Requires historical second-environment registry and worktree fixture.',
 'src/environments/verify-api.ts':'Requires two-environment/worktree fixture setup; evaluated separately.',
 'src/dock/verify-explorer.ts':'Hardcoded .p5/project fixture; evaluated separately.',
 'src/split/verify.state.ts':'Subprocess assertion helper executed by bun test; overwrites daemon files by design.',
 'src/shell/verify.selection.ts':'Subprocess assertion helper executed by bun test.',
 'src/shell/verify.persistence.ts':'Two-phase subprocess helper; evaluated separately.',
 'src/shell/verify.running.ts':'Fixture application, not standalone verification.',
 'src/pulls/verify.fixture.ts':'Exports mock server, not standalone verification.',
 'src/shell/verify.fixture.ts':'Scratch wrapper used by this runner.',
 'src/dock/verify-run.ts':'Scratch wrapper; replaced by independent fresh fixtures in this runner.',
 'src/transcript/scratch.verify.ts':'Scratch wrapper used by this runner.',
 'src/requests/perf.verify.ts':'Hardcodes shared fixture data/native checkout; dedicated audit performance snapshot supersedes it.',
}
results=json.loads((OUT/"results.json").read_text()) if (OUT/"results.json").exists() else []
completed={(r["file"],r["mode"]) for r in results}
def save(): (OUT/'results.json').write_text(json.dumps(results,indent=2))
for file in files:
 if file in skip:
  if (file,"n/a") in completed:continue
  results.append(dict(file=file,mode='n/a',status='Not standalone' if 'helper' in skip[file] or 'wrapper' in skip[file] or 'Exports' in skip[file] or 'application' in skip[file] else 'Blocked',detail=skip[file]));save();continue
 # Performance samplers are measured once; pure code and self-matrix tests need no duplicate reduced run.
 src=pathlib.Path(file).read_text()
 modes=['normal'] if ('perf' in file or 'memory' in file or 'check-integration' in file or file.endswith(('reveal.verify.ts','collapse.verify.ts','popup-reduced.verify.ts','home.verify.ts','session.verify.ts','lifecycle.verify.ts','verify.replay.ts'))) else ['normal','reduced']
 for mode in modes:
  if (file,mode) in completed:continue
  ident=file.replace('/','__')+'.'+mode
  folder=OUT/ident;folder.mkdir(exist_ok=True)
  env=os.environ.copy();env.update(GPUIX_BACKGROUND='1',KYBERN_REDUCED_MOTION='1' if mode=='reduced' else '0',NAPI_RS_NATIVE_LIBRARY_PATH=str(ROOT/'native/build/gpuix-native.darwin-arm64.node'),KYBERN_VERIFY_OUTPUT=str(folder),KYBERN_PARITY_OUT=str(folder),KYBERN_URL='',KYBERN_TOKEN='')
  args=['bun',file]
  if file in ['scripts/shell-check.ts','scripts/settings-check.ts']:args.append(str(folder))
  if mode=='reduced' and file in ['scripts/pages-native-check.ts','src/usage/verify.native.ts']:args.append('--reduced')
  if file=='src/split/native.verify.ts':args.append('--drag')
  wrapper='src/shell/verify.fixture.ts' if file.startswith('src/shell/') else 'src/transcript/scratch.verify.ts'
  cmd=['bun',wrapper,*args]
  log=OUT/(ident+'.log');start=time.monotonic()
  with log.open('w') as output:
   proc=subprocess.Popen(cmd,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
   try: code=proc.wait(timeout=300 if ('notes/verify' in file or 'tasks/verify' in file or 'memory' in file or 'perf' in file) else 150)
   except subprocess.TimeoutExpired: code=124
   # Kill only processes in this check's new process group, including orphan fixture children.
   try:os.killpg(proc.pid,signal.SIGTERM)
   except OSError:pass
  record=dict(file=file,mode=mode,status='Pass' if code==0 else 'Timeout' if code==124 else 'Fail',exit=code,seconds=round(time.monotonic()-start,2),command=cmd,log=str(log),tail=log.read_text(errors='replace')[-2200:])
  results.append(record);save();print(file,mode,record['status'],flush=True)
