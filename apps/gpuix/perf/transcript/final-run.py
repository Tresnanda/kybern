"""Take the reserved quiet window and run three bounded UI batches."""
import json, os, pathlib, signal, subprocess, time

tmp=pathlib.Path('/tmp')
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/transcript')
quiet=tmp/'kybern-gpuix-quiet.perf-transcript'
next_quiet=tmp/'kybern-gpuix-quiet-next.perf-transcript'
order=tmp/'kybern-gpuix-quiet-order'
def lanes():return order.read_text().splitlines() if order.exists() else []
def interrupted(signum,frame):raise KeyboardInterrupt('Transcript timing interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
if not json.loads((out/'final-correctness-ready.json').read_text())['passed']:
 raise RuntimeError('Run final correctness checks first')
while (list(tmp.glob('kybern-gpuix-native-build.*')) or list(tmp.glob('kybern-gpuix-quiet.*'))
       or list(tmp.glob('kybern-gpuix-build-next.*'))
       or not lanes() or lanes()[0]!='perf-transcript'):time.sleep(2)
start=time.time()
with quiet.open('x') as f:f.write(f'perf-transcript start={start} expected_end={start+1500}\n')
next_quiet.unlink(missing_ok=True)
child=None
try:
 for case in ['1000','3000','stream']:
  with (out/f'final-timing-{case}.log').open('w') as log:
   child=subprocess.Popen(['python3','perf/transcript/lease.py','bun','perf/transcript/final-pair.ts',case],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   code=child.wait(timeout=max(1,1500-(time.time()-start)))
   if code:raise RuntimeError(f'Final {case} batch failed; see its log')
  print(f'PASS final timing {case}',flush=True)
finally:
 if child is not None and child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 quiet.unlink(missing_ok=True)
 next_quiet.unlink(missing_ok=True)
 order.write_text(''.join(lane+'\n' for lane in lanes() if lane!='perf-transcript'))
 (out/'quiet-window.json').write_text(json.dumps({'start':start,'end':time.time(),'seconds':time.time()-start},indent=2))
