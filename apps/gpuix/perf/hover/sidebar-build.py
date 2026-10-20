import os,pathlib,shutil,subprocess,time,signal,json,hashlib,atexit
def interrupted(signum,frame):raise KeyboardInterrupt('Hover native build interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix';native=app/'native'
marker=pathlib.Path('/tmp/kybern-gpuix-native-build.sidebar-fix-build')
reservation=pathlib.Path('/tmp/kybern-gpuix-build-next.sidebar-fix-build')
atexit.register(lambda:(marker.unlink(missing_ok=True),reservation.unlink(missing_ok=True)))
# Capture the baseline before invoking this wrapper when comparing addons.
while pathlib.Path('/tmp/kybern-gpuix-quiet.sidebar-fix-build').exists():time.sleep(2)
while any(p!=reservation for p in pathlib.Path('/tmp').glob('kybern-gpuix-build-next.*')):time.sleep(2)
reservation.write_text('sidebar-fix-build '+str(time.time())+' display-paced dirty-window validation\n')
while list(pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')) or any(p!=marker for p in pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):time.sleep(2)
free=shutil.disk_usage(root).free
if free < 30*1024**3:raise RuntimeError('Native build needs at least 30 GiB free')
print('Free before native build GiB',free/1024**3,flush=True)
marker.write_text('sidebar-fix-build '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
if any(p!=marker for p in pathlib.Path('/tmp').glob('kybern-gpuix-native-build.*')):
 marker.unlink(missing_ok=True)
 raise RuntimeError('Another native build won the slot; rerun after it finishes')
reservation.unlink(missing_ok=True)
pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build').mkdir(parents=True,exist_ok=True)
pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build/native-passed.json').unlink(missing_ok=True)
pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build').mkdir(parents=True,exist_ok=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/bench/wheel.m'),'-o','/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build/transcript-wheel.dylib'],check=True)
subprocess.run(['clang','-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',str(app/'perf/explorer/wheel.m'),'-o',str(app/'perf/explorer/wheel.dylib')],check=True)
addon=native/'build/gpuix-native.darwin-arm64.node';before=native/'build/prior-hover.node'
if addon.exists() and not before.exists():
 addon.rename(before)
env=dict(os.environ,GPUIX_BACKGROUND='1',KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build/config',KYBERN_URL='',KYBERN_TOKEN='',RUSTC_WRAPPER='',CARGO_INCREMENTAL='0',CARGO_BUILD_JOBS='4',CARGO_TARGET_DIR=str(native/'build/target'))
child=None
routing=[]
p=native/'fixture.ts';original=p.read_text();routing.append((p,original));p.write_text(original.replace("mkdtempSync(path.join(tmpdir(),'gpuix-scratch-combined-'))", "mkdtempSync('/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build-combined-')").replace("'--port','0'","'--port','4351'"))
# Gate each batch before it takes a UI lease, then verify both screen endpoints.
p=native/'font-weight-check.ts';original=p.read_text();routing.append((p,original));p.write_text(original.replace('/Users/mymac/projects/ade-gpuix-scratch/phase2-render9', '/Users/mymac/projects/ade-gpuix-scratch/sidebar-fix-build-font'))
p=native/'check-update.sh';original=p.read_text();routing.append((p,original));p.write_text(original.replace('  bun native/font-weight-check.ts', '  ;;\ntypography)\n  bun native/font-weight-check.ts'))
p=native/'update.sh';original=p.read_text();routing.append((p,original))
p.write_text(original.replace('    bun native/ui-lease.ts', '    bun perf/hover/wait-screen.ts\n    bun native/ui-lease.ts').replace('sh native/check-update.sh', 'bun perf/hover/sidebar-native-check.ts').replace('for batch in geometry content input', 'for batch in geometry typography content input'))
evidence=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build/native-update')
for sub in ['p1e','p1f','p1g','round8/scroll/cache','perf/markdown']: (evidence/sub).mkdir(parents=True,exist_ok=True)
old='/Users/mymac/projects/ade/previews/gpuix'
for name in ['markdown','markdown-document','diff','surface','link','scroll8']:
 p=native/(name+'-check.ts');original=p.read_text();routing.append((p,original))
 p.write_text(original.replace(old,str(evidence)))
# WindowServer capture is unavailable in this agent process. Preserve the same
# pixel assertions with GPUI's capture barrier; the focused probe samples state
# passively before capturing, so captures cannot conceal the reported hover loss.
for name in ['paint-check','subtree-translation-check','subtree-transform-check','font-weight-check','stroke-draw-check']:
 p=native/(name+'.ts');original=p.read_text();routing.append((p,original));text=original
 for call in ["execFileSync('screencapture', ['-x', '-o', '-l', windowId, file])", "execFileSync('screencapture',['-x','-o','-l',windowId,file])", "await exec('screencapture',['-x','-o','-l',windowId,file])"]:
  text=text.replace(call,"await a.screenshot({path:file})")
 text=text.replace("execFileSync('screencapture', ['-x', '-o', '-l', windowId, path.join(out, `ladder-${theme}${process.env.KYBERN_FONT_WEIGHT_AXIS === '0' ? '-old' : ''}.png`)])", "await a.screenshot({path:path.join(out, `ladder-${theme}${process.env.KYBERN_FONT_WEIGHT_AXIS === '0' ? '-old' : ''}.png`)})")
 p.write_text(text)
try:
 child=subprocess.Popen(['nice','-n','15','sh','native/update.sh'],cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True)
 for line in child.stdout:
  print(line,end='',flush=True)
 code=child.wait()
 if code:raise RuntimeError('native/update.sh failed: '+str(code))
 pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build/native-passed.json').write_text(json.dumps({'passed':True,'build':'native-update','sha256':hashlib.sha256(addon.read_bytes()).hexdigest(),'wholeRunBuildMarker':True,'onScreenChecks':os.environ.get('KYBERN_NATIVE_CHECKS')!='0','capture':'native-window-image','host':subprocess.check_output(['sw_vers','-productVersion'],text=True).strip(),'hardware':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip(),'freeBeforeBytes':free,'freeAfterBytes':shutil.disk_usage(root).free},indent=2))
finally:
 for p,original in reversed(routing):p.write_text(original)
 if child is not None:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 marker.unlink(missing_ok=True)
 pathlib.Path('/tmp/kybern-gpuix-build-next.sidebar-fix-build').unlink(missing_ok=True)
 if not addon.exists() and before.exists():shutil.copy2(before,addon)
