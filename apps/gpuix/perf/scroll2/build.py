import os,pathlib,shutil,subprocess,time,signal,json,hashlib,atexit
def interrupted(signum,frame):raise KeyboardInterrupt('Transcript native build interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix';native=app/'native'
marker=pathlib.Path('/tmp/kybern-gpuix-native-build.perf-scroll2')
reservation=pathlib.Path('/tmp/kybern-gpuix-build-next.perf-scroll2')
atexit.register(lambda:(marker.unlink(missing_ok=True),reservation.unlink(missing_ok=True)))
while any(p!=reservation for p in pathlib.Path('/tmp').glob('kybern-gpuix-build-next.*')):time.sleep(2)
reservation.write_text('perf-scroll2 '+str(time.time())+' final sparse list validation\n')
while list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')) or any(p!=marker for p in pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):time.sleep(2)
free=shutil.disk_usage(root).free
if free < 30*1024**3:raise RuntimeError('Native build needs at least 30 GiB free')
print('Free before native build GiB',free/1024**3,flush=True)
marker.write_text('perf-scroll2 '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/native-passed.json').unlink(missing_ok=True)
pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2').mkdir(parents=True,exist_ok=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/bench/wheel.m'),'-o','/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/transcript-wheel.dylib'],check=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/explorer/wheel.m'),'-o',str(app/'perf/explorer/wheel.dylib')],check=True)
addon=native/'build/gpuix-native.darwin-arm64.node';before=native/'build/prior-scroll2.node'
if addon.exists():
 before.unlink(missing_ok=True)
 addon.rename(before)
env=dict(os.environ,KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/config',KYBERN_URL='',KYBERN_TOKEN='',RUSTC_WRAPPER='',CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='4',CARGO_TARGET_DIR=str(native/'build/target'))
child=None
routing=[]
evidence=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/native-update-8')
for sub in ['p1e','p1f','p1g','round8/scroll/cache']: (evidence/sub).mkdir(parents=True,exist_ok=True)
old='/Users/mymac/projects/ade/previews/gpuix'
for name in ['markdown','diff','surface','link','scroll8']:
 p=native/(name+'-check.ts');original=p.read_text();routing.append((p,original))
 p.write_text(original.replace(old,str(evidence)))
try:
 child=subprocess.Popen(['nice','-n','15','sh','native/update.sh'],cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True)
 for line in child.stdout:
  print(line,end='',flush=True)
 code=child.wait()
 if code:raise RuntimeError('native/update.sh failed: '+str(code))
 pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/native-passed.json').write_text(json.dumps({'passed':True,'build':'native-update-8','sha256':hashlib.sha256(addon.read_bytes()).hexdigest(),'wholeRunBuildMarker':True,'host':subprocess.check_output(['sw_vers','-productVersion'],text=True).strip(),'hardware':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip(),'freeBeforeBytes':free,'freeAfterBytes':shutil.disk_usage(root).free},indent=2))
finally:
 for p,original in routing:p.write_text(original)
 if child is not None:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 marker.unlink(missing_ok=True)
 pathlib.Path('/tmp/kybern-gpuix-build-next.perf-scroll2').unlink(missing_ok=True)
 if not addon.exists() and before.exists():before.rename(addon)
