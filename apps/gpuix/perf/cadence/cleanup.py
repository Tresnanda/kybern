"""Remove this lane's disposable outputs only, after successful UI validation."""
import json,os,re,shutil,signal,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parents[4]
assert root==Path('/Users/mymac/projects/ade-gpuix-perf-cadence'),root
scratch=Path('/Users/mymac/projects/ade-gpuix-scratch')
out=Path('/Users/mymac/projects/ade/previews/gpuix/perf/cadence')
processes=subprocess.check_output(['ps','-Ao','pid=,command='],text=True).splitlines()
owned=[]
for line in processes:
 pid,command=line.strip().split(None,1)
 if 'kybernd --data-dir '+str(scratch/'perf-cadence') in command or (re.match(r'(?:/\S*/)?bun\s',command) and str(root) in command and re.search(r'/(?:app\.ts|loops-app\.tsx|main\.tsx)(?:\s|$)',command)):
  owned.append(int(pid));os.kill(int(pid),signal.SIGTERM)
for pid in owned:
 for _ in range(100):
  try:os.kill(pid,0)
  except ProcessLookupError:break
  time.sleep(.05)
 else:raise RuntimeError(f'Scratch process still alive: {pid}')
manifest=scratch/'perf-cadence-bench/bench-manifest.json'
if manifest.exists():shutil.copy2(manifest,out/'diagnostics/bench-manifest.json')
probe=scratch/'perf-cadence-probe.m'
if probe.exists():shutil.copy2(probe,out/'diagnostics/probe-source.m')
paths=[root/'apps/gpuix/node_modules',root/'apps/desktop/node_modules',root/'apps/gpuix/perf/explorer/wheel.dylib',out/'diagnostics/wheel-check',*scratch.glob('perf-cadence*')]
# No live renderer, daemon or build may hold disposable task output.
for directory in paths[:2]:
 if directory.exists():
  opened=subprocess.run(['lsof','-nP','+D',str(directory)],capture_output=True,text=True)
  if opened.stdout.strip():raise RuntimeError('Disposable dependencies are still open: '+opened.stdout[:2000])
free=lambda:shutil.disk_usage(root).free/1024**3
before=free();removed=[]
for p in paths:
 if not p.exists() and not p.is_symlink():continue
 size=subprocess.run(['du','-sk',str(p)],capture_output=True,text=True).stdout.split()[0]
 removed.append({'path':str(p),'allocatedKiB':int(size)})
 if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
 else:p.unlink()
known={68054,69829,72224}
for p in Path('/tmp').glob('kybern-gpuix-lease-watch.*.log'):
 text=p.read_text();match=re.search(r'watch (\d+)',text)
 if str(root) in text or match and int(match[1]) in known:
  shutil.copy2(p,out/'diagnostics'/p.name);p.unlink()
retained=[{'path':str(root/'apps/gpuix/native/build/gpuix-native.darwin-arm64.node'),'reason':'Inherited validated signed combined addon f7c8af1c; no native build in this lane.'},{'path':str(out),'reason':'Requested raw timings, logs, screenshots and frame-strip evidence.'}]
report={'freeGiBBeforeCleanup':before,'freeGiBAfterCleanup':free(),'removed':removed,'stoppedScratchPids':owned,'retained':retained,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
(out/'diagnostics/cleanup.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
