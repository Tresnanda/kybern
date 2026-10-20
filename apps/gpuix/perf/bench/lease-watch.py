"""Independent PID lease guardian; all queue/lock cleanup is serialized."""
import fcntl,json,os,pathlib,sys,time
mode=sys.argv[1];pid=int(sys.argv[2]);root=sys.argv[3];lane=sys.argv[4]
lock=pathlib.Path(sys.argv[5]);queue=pathlib.Path(sys.argv[6]);token=pathlib.Path(sys.argv[7]) if len(sys.argv)>7 else None
def alive():
 try:os.kill(pid,0);return True
 except ProcessLookupError:return False
def reap():
 queue.touch(exist_ok=True)
 with queue.open('r+') as f:
  fcntl.flock(f,fcntl.LOCK_EX)
  if alive():return
  owner=lock/'owner';marker=lock/'bench-pid'
  if owner.exists() and owner.read_text()==root and marker.exists() and marker.read_text()==str(pid):
   marker.unlink();owner.unlink();lock.rmdir()
  lines=[x for x in f.read().splitlines() if x and x!=lane]
  f.seek(0);f.write(''.join(x+'\n' for x in lines));f.truncate()
  if token:token.unlink(missing_ok=True)
if mode=='watch':
 # A separate session outside Bun's direct-child registry survives immediate
 # uncaught exceptions, SIGKILL and wrapper group teardown.
 if os.fork():sys.exit(0)
 os.setsid()
 print('watch',pid,root,flush=True,file=sys.stderr)
 while alive() and token.exists():time.sleep(.5)
 if not token.exists():sys.exit(0)
 print('owner exited',pid,flush=True,file=sys.stderr)
reap()
