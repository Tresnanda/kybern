import os,pathlib,shutil,subprocess,time,signal,json,hashlib,atexit
def interrupted(signum,frame):raise KeyboardInterrupt('Hover native build interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix';native=app/'native'
marker=pathlib.Path('/tmp/kybern-gpuix-native-build.hr5-hover')
reservation=pathlib.Path('/tmp/kybern-gpuix-build-next.hr5-hover')
atexit.register(lambda:(marker.unlink(missing_ok=True),reservation.unlink(missing_ok=True)))
# Capture the baseline before invoking this wrapper when comparing addons.
while pathlib.Path('/tmp/kybern-gpuix-quiet.hr5-hover').exists():time.sleep(2)
while any(p!=reservation for p in pathlib.Path('/tmp').glob('kybern-gpuix-build-next.*')):time.sleep(2)
reservation.write_text('hr5-hover '+str(time.time())+' display-paced dirty-window validation\n')
while list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')) or any(p!=marker for p in pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):time.sleep(2)
free=shutil.disk_usage(root).free
if free < 30*1024**3:raise RuntimeError('Native build needs at least 30 GiB free')
print('Free before native build GiB',free/1024**3,flush=True)
marker.write_text('hr5-hover '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
if any(p!=marker for p in pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):
 marker.unlink(missing_ok=True)
 raise RuntimeError('Another native build won the slot; rerun after it finishes')
reservation.unlink(missing_ok=True)
pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover').mkdir(parents=True,exist_ok=True)
pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/native-passed.json').unlink(missing_ok=True)
pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/hr5-hover').mkdir(parents=True,exist_ok=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/bench/wheel.m'),'-o','/Users/mymac/projects/ade-gpuix-scratch/hr5-hover/transcript-wheel.dylib'],check=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/explorer/wheel.m'),'-o',str(app/'perf/explorer/wheel.dylib')],check=True)
addon=native/'build/gpuix-native.darwin-arm64.node';before=native/'build/prior-hover.node'
if addon.exists() and not before.exists():
 addon.rename(before)
env=dict(os.environ,GPUIX_BACKGROUND='1',KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/hr5-hover',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/hr5-hover/config',KYBERN_URL='',KYBERN_TOKEN='',RUSTC_WRAPPER='',CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='4',CARGO_TARGET_DIR=str(native/'build/target'))
child=None
routing=[]
p=native/'fixture.ts';original=p.read_text();routing.append((p,original));p.write_text(original.replace("mkdtempSync(path.join(tmpdir(),'gpuix-scratch-combined-'))", "mkdtempSync('/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-combined-')").replace("'--port','0'","'--port','4342'"))
# Gate each batch before it takes a UI lease, then verify both screen endpoints.
p=native/'update.sh';original=p.read_text();routing.append((p,original))
p.write_text(original.replace('    bun native/ui-lease.ts', '    bun perf/hover/wait-screen.ts\n    bun native/ui-lease.ts').replace('sh native/check-update.sh', 'bun perf/hover/native-check.ts'))
evidence=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/native-update')
for sub in ['p1e','p1f','p1g','round8/scroll/cache','perf/markdown']: (evidence/sub).mkdir(parents=True,exist_ok=True)
old='/Users/mymac/projects/ade/previews/gpuix'
for name in ['markdown','markdown-document','diff','surface','link','scroll8']:
 p=native/(name+'-check.ts');original=p.read_text();routing.append((p,original))
 p.write_text(original.replace(old,str(evidence)))
try:
 child=subprocess.Popen(['nice','-n','15','sh','native/update.sh'],cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True)
 for line in child.stdout:
  print(line,end='',flush=True)
 code=child.wait()
 if code:raise RuntimeError('native/update.sh failed: '+str(code))
 pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/native-passed.json').write_text(json.dumps({'passed':True,'build':'native-update','sha256':hashlib.sha256(addon.read_bytes()).hexdigest(),'wholeRunBuildMarker':True,'host':subprocess.check_output(['sw_vers','-productVersion'],text=True).strip(),'hardware':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip(),'freeBeforeBytes':free,'freeAfterBytes':shutil.disk_usage(root).free},indent=2))
finally:
 for p,original in routing:p.write_text(original)
 if child is not None:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 marker.unlink(missing_ok=True)
 pathlib.Path('/tmp/kybern-gpuix-build-next.hr5-hover').unlink(missing_ok=True)
 if not addon.exists() and before.exists():shutil.copy2(before,addon)
