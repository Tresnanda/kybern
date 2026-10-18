import os, pathlib, sys, time, subprocess, signal
def interrupted(signum, frame):raise KeyboardInterrupt('Transcript lease interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
queue=pathlib.Path('/tmp/kybern-gpuix-ui-queue');lock=pathlib.Path('/tmp/kybern-gpuix-round5-ui-lock')
root=str(pathlib.Path(__file__).resolve().parents[4]);lane='perf-transcript-'+str(os.getpid())
def lines():return queue.read_text().splitlines() if queue.exists() else []
def leave():
 current=lines()
 if lane in current:queue.write_text(''.join(x+'\n' for x in current if x!=lane))
timed=any(pathlib.Path(arg).name in {'final-pair.ts','checks.ts','slot-pair.ts','p1-pair.ts','long-pair.ts','stream-pair.ts','run.ts'} for arg in sys.argv[1:]) and os.environ.get('TRANSCRIPT_CAPTURE')!='1'
while timed and list(pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):
 leave();time.sleep(2)
if lane not in lines():
 with queue.open('a') as f:f.write(lane+'\n')
held=False
try:
 while not held:
  if timed and list(pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):
   leave();time.sleep(2);continue
  if lane not in lines():
   with queue.open('a') as f:f.write(lane+'\n')
  if lines() and lines()[0]==lane and not lock.exists():
   try:lock.mkdir();(lock/'owner').write_text(root);held=True
   except FileExistsError:pass
  if not held:time.sleep(2)
 env=dict(os.environ,KYBERN_PACING_PARENT_LEASE=root,KYBERN_CLIP_LOCK_HELD='1')
 child=subprocess.Popen(sys.argv[1:],env=env,start_new_session=True)
 try:code=child.wait(timeout=290)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
  raise RuntimeError('Transcript UI batch exceeded the 290s budget; own processes stopped')
 except BaseException:
  if child.poll() is None:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
  raise
 sys.exit(code)
finally:
 leave()
 if held and (lock/'owner').read_text()==root:(lock/'owner').unlink();lock.rmdir()
