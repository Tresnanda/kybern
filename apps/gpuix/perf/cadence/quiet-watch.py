"""Independent lease guardian: survives wrapper SIGKILL, owns only its run."""
import fcntl,json,os,pathlib,signal,sys,time
if len(sys.argv)>4 and sys.argv[4]=='--detach':
 if os.fork():sys.exit(0)
 os.setsid()
state=pathlib.Path(sys.argv[1]);pid=int(sys.argv[2]);lane=sys.argv[3]
while state.exists():
 try:os.kill(pid,0)
 except ProcessLookupError:break
 time.sleep(.5)
else:sys.exit(0)
run=json.loads(state.read_text())
if run.get('group'):
 try:os.killpg(run['group'],signal.SIGTERM);time.sleep(1);os.killpg(run['group'],signal.SIGKILL)
 except (ProcessLookupError,PermissionError):pass
quiet=pathlib.Path(run.get('quiet','/tmp/kybern-gpuix-quiet.'+lane))
if quiet.exists() and quiet.read_text()==run.get('token'):quiet.unlink()
order=pathlib.Path(run.get('order','/tmp/kybern-gpuix-quiet-order'));order.touch(exist_ok=True)
with order.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX);a=[x for x in f.read().splitlines() if x and x!=lane]
 f.seek(0);f.write(''.join(x+'\n' for x in a));f.truncate()
state.unlink(missing_ok=True)
