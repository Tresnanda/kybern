import os,pathlib,shutil,subprocess,time,signal
def interrupted(signum,frame):raise KeyboardInterrupt('Transcript native build interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix';native=app/'native'
marker=pathlib.Path('/tmp/kybern-gpuix-native-build.perf-transcript')
while list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')):time.sleep(2)
source=pathlib.Path('/Users/mymac/projects/ade-gpuix-editor9/apps/gpuix/native/upstream')
dest=native/'upstream'
if not dest.exists() and source.exists():shutil.copytree(source,dest,ignore=shutil.ignore_patterns('target','node_modules','.DS_Store'))
marker.write_text('perf-transcript '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
addon=native/'build/gpuix-native.darwin-arm64.node';before=native/'build/before-transcript.node'
if addon.exists():
 if not before.exists():addon.rename(before)
 else:addon.unlink()
env=dict(os.environ,KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript/config',KYBERN_URL='',KYBERN_TOKEN='',RUSTC_WRAPPER='',CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='4',CARGO_TARGET_DIR=str(native/'build/target'))
child=None
try:
 child=subprocess.Popen(['nice','-n','15','sh','native/update.sh'],cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True)
 for line in child.stdout:
  print(line,end='',flush=True)
  if line.startswith('== checks'):marker.unlink(missing_ok=True)
 code=child.wait()
 if code:raise RuntimeError('native/update.sh failed: '+str(code))
 pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/transcript/native-passed.json').write_text('{"passed":true}\n')
finally:
 if child is not None and child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 marker.unlink(missing_ok=True)
 if not addon.exists() and before.exists():before.rename(addon)
