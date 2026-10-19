"""Reuse the previous lanes' interaction assertions under owned scratch paths."""
import os,pathlib,subprocess,time,signal,json
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix'
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/flick');out.mkdir(parents=True,exist_ok=True)
cases=[('synchronous-snapshot',['bun','perf/flick/snapshot.ts'],{}),('transcript-pixels',['bun','perf/flick/visual.ts'],{}),('transcript',['bun','perf/flick/reuse.ts','perf/scroll2/verify-transcript.ts'],{}),('cross-turn-copy',['bun','perf/flick/reuse.ts','perf/scroll2/verify-transcript.ts'],{'TRANSCRIPT_COMPACT':'1'}),('list-anchors',['bun','perf/flick/reuse.ts','perf/scroll2/verify-list.ts'],{}),('preview-pixels',['bun','perf/flick/bench-visual.ts'],{})]
child=None
def stop(signum,frame):
 if child and child.poll() is None:child.terminate()
 raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
def run(label,command,extra):
 global child
 for attempt in range(4):
  while list(pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):time.sleep(1)
  env=dict(os.environ,KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-checks',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-checks',KYBERN_URL='',KYBERN_TOKEN='',KYBERN_FULL_RATE='1',**extra)
  gate_file=out/'checks'/f'{label}-gate.json';gate_file.unlink(missing_ok=True)
  with (out/('verify-'+label+'.log')).open('w') as log:
   child=subprocess.Popen(command,cwd=app,env=env,stdout=log,stderr=subprocess.STDOUT)
   code=child.wait()
  if not code:break
  gate=json.loads(gate_file.read_text()) if gate_file.exists() else {}
  if not gate.get('overlap') or gate.get('screenInvalid') or gate.get('orphanOverlap') or attempt==3:
   raise RuntimeError('Verifier failed '+label+'; see verify-'+label+'.log')
  print('Discarded '+label+' for build overlap; retrying',flush=True)
 print('PASS '+label,flush=True)
try:
 for label,command,extra in cases:run(label,['bun','native/ui-lease.ts','perf-flick-'+label,'bun','perf/flick/check.ts',label,*command],extra)
 run('sidebar',['bun','perf/scroll2/fixture.ts','bun','perf/flick/sidebar-suite.ts'],{'SCROLL2_DATA_DIR':'/Users/mymac/projects/ade-gpuix-scratch/perf-flick/sidebar','SCROLL2_PORT':'4339'})
 run('task-project-drag',['python3','perf/flick/task-checks.py'],{})
finally:
 if child and child.poll() is None:child.terminate();child.wait(timeout=5)
