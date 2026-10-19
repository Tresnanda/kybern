"""Existing board/list edge-scroll, drop/Escape and project drag verifiers."""
import os,pathlib,subprocess,signal,time,shutil
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix'
data=pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/perf-flick/tasks')
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/flick/tasks');out.mkdir(parents=True,exist_ok=True)
assert not (data/'daemon.port').exists(),'Refusing existing daemon'
while list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')):time.sleep(1)
data.mkdir(parents=True,exist_ok=True);daemon=None;child=None

def stop(signum,frame):
 if child and child.poll() is None:child.terminate()
 raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
try:
 daemon=subprocess.Popen(['/Applications/kybern.app/Contents/MacOS/kybernd','--data-dir',str(data),'--port','4339'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 deadline=time.time()+30
 while not (data/'daemon.port').exists():
  if time.time()>deadline or daemon.poll() is not None:raise RuntimeError('Scratch daemon failed')
  time.sleep(.05)
 for theme,reduced in [('dark','0'),('light','1')]:
  case=out/(theme+'-'+reduced);case.mkdir(parents=True,exist_ok=True)
  env=dict(os.environ,KYBERN_DATA_DIR=str(data),KYBERN_CLIENT_CONFIG_DIR=str(data/'client'),KYBERN_URL='',KYBERN_TOKEN='',R8_DATA=str(data),R8_OUT=str(case),R7_LOCK_HELD='1',R7_LABEL='sparse',KYBERN_APPEARANCE=theme,KYBERN_REDUCED_MOTION=reduced,KYBERN_FULL_RATE='1',KYBERN_WINDOW_SIZE='1280x820')
  child=subprocess.Popen(['bun','native/ui-lease.ts','perf-flick-tasks','bun','perf/flick/check.ts','tasks-'+theme+'-'+reduced,'bun','perf/flick/task-entry.ts'],cwd=app,env=env)
  # Queue time is separate: check.ts bounds the active UI batch to 285 s.
  if child.wait():raise RuntimeError('Task drag verifier failed '+theme)
finally:
 if child and child.poll() is None:child.terminate();child.wait(timeout=5)
 if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=5)
 shutil.rmtree(data,ignore_errors=True)
