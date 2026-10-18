"""Retime the 3,000-turn pair after a rejected no-work capture."""
import os,pathlib,signal,subprocess,time,json,shutil
tmp=pathlib.Path('/tmp');order=tmp/'kybern-gpuix-quiet-order'
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/transcript')
quiet=tmp/'kybern-gpuix-quiet.perf-transcript'
def lanes():return order.read_text().splitlines() if order.exists() else []
def interrupted(signum,frame):raise KeyboardInterrupt('Transcript retiming interrupted')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
while (not lanes() or lanes()[0]!='perf-transcript' or list(tmp.glob('kybern-gpuix-quiet.*')) or list(tmp.glob('kybern-gpuix-native-build.*')) or list(tmp.glob('kybern-gpuix-build-next.*'))):time.sleep(2)
rejected=out/'rejected-3000';rejected.mkdir(exist_ok=True)
for pattern in ['baseline-final-fixed-3000-dark*','final-fixed-3000-dark*']:
 for path in out.glob(pattern):shutil.move(str(path),str(rejected/path.name))
start=time.time()
with quiet.open('x') as f:f.write(f'perf-transcript start={start} expected_end={start+600} retime-3000\n')
child=None
try:
 with (out/'final-timing-3000-retry.log').open('w') as log:
  env=dict(os.environ,TRANSCRIPT_PREFLIGHT='1')
  child=subprocess.Popen(['python3','perf/transcript/lease.py','sh','-c','pnpm exec tsc -p perf/transcript/tsconfig.json && bun perf/transcript/final-pair.ts 3000'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  code=child.wait(timeout=600)
  if code:raise RuntimeError('3,000-turn retime rejected; inspect the retry log')
finally:
 if child is not None and child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 quiet.unlink(missing_ok=True)
 order.write_text(''.join(lane+'\n' for lane in lanes() if lane!='perf-transcript'))
 (out/'quiet-window-retry.json').write_text(json.dumps({'start':start,'end':time.time(),'seconds':time.time()-start},indent=2))
