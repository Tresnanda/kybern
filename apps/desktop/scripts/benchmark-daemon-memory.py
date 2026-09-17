"""Matched synthetic daemon-only workload. Run after all compilers have exited.
Usage: python3 benchmark-daemon-memory.py CHECKOUT RUN_LABEL ARTIFACT_DIR [DAEMON_BINARY]
The optional binary permits alternating baseline/candidate runs without rebuilding.
Reports sampled footprint, not a guaranteed lifetime/startup peak or whole-app RAM.
"""
import sys,subprocess,time,json,importlib.util,os,shutil
from pathlib import Path
repo=Path(sys.argv[1]).resolve(); artifacts=Path(sys.argv[3]).resolve(); label=sys.argv[2]
if not label or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in label): raise ValueError('Use a simple run label')
artifacts.mkdir(parents=True, exist_ok=True)
scripts=Path(__file__).parent
binary=Path(sys.argv[4]).resolve() if len(sys.argv)>4 else repo/'target/release/kybernd'
spec=importlib.util.spec_from_file_location('sampler',scripts/'profile-memory.py'); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sampler=m.Sampler(); root=repo/'.scratch'/label
root.mkdir(parents=True,exist_ok=False)
# Initialize the real schema. Never use the user's data.
subprocess.run([str(binary),'--data-dir',str(root),'--print-token'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
subprocess.run([sys.executable,str(scripts/'seed-memory-workload.py'),str(root)],check=True)
with (artifacts/(label+'-daemon.log')).open('w') as logs:
 start=time.monotonic(); p=subprocess.Popen([str(binary),'--data-dir',str(root),'--port','0'],stdout=logs,stderr=logs)
 records=[]; worker=None
 try:
  while time.monotonic()-start < 120:
   if p.poll() is not None:raise RuntimeError('daemon exited')
   phase=(root/'phase').read_text() if (root/'phase').exists() else 'startup-observed'
   records.append(dict(elapsed=time.monotonic()-start,phase=phase,pid=p.pid,**sampler.sample(p.pid)))
   if worker is None and (root/'daemon.port').exists():
    worker=subprocess.Popen(['node','--experimental-strip-types',str(scripts/'memory-workload.mjs'),str(repo),str(root),str(artifacts/(label+'-latency.json'))],stdout=logs,stderr=logs)
   if worker is not None and worker.poll() is not None:
    if worker.returncode:raise RuntimeError('workload failed; see daemon log')
    break
   time.sleep(.1)
  else:raise RuntimeError('workload timeout')
 finally:
  if worker and worker.poll() is None:worker.terminate();worker.wait()
  p.terminate();p.wait()
  (artifacts/(label+'-samples.json')).write_text(json.dumps(records))
print(json.dumps({'label':label,'samples':len(records),'scope':'daemon only','pid':p.pid}))
