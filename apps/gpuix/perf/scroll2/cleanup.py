"""Remove only this lane's disposable runtime/build files after all captures."""
import pathlib,os,signal,subprocess,shutil,time,json,re
root=pathlib.Path(__file__).resolve().parents[4];app=root/'apps/gpuix'
assert root.name=='ade-gpuix-perf-scroll2'
data=pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2')
assert data.resolve()==data
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2')
assert not pathlib.Path('/tmp/kybern-gpuix-native-build.perf-scroll2').exists()
while any(p.name!='kybern-gpuix-quiet.perf-scroll2' for p in pathlib.Path('/tmp').glob('kybern-gpuix-quiet.*')):time.sleep(1)
def free():
 s=os.statvfs(root);return s.f_bavail*s.f_frsize
report={'freeBeforeBytes':free(),'removed':[],'stopped':[]}
# No app/fixture is permitted to survive a completed runner. Only our absolute
# entry paths and our explicitly assigned daemon directories qualify here.
for line in subprocess.check_output(['ps','-axo','pid=,command='],text=True).splitlines():
 bits=line.strip().split(None,1)
 if len(bits)!=2:continue
 pid,command=int(bits[0]),bits[1]
 owned_app=('bun '+str(app)+'/') in command and ('.tsx' in command or bool(re.search(r'/(?:[^ /]*-app|app|entry|main)\.ts(?:\s|$)',command)))
 owned_daemon=bool(re.search(r'/kybernd --data-dir '+re.escape(str(data))+r'(?:/|\s|$)',command))
 if (owned_app or owned_daemon) and pid!=os.getpid():
  os.kill(pid,signal.SIGTERM);report['stopped'].append({'pid':pid,'command':command})
if report['stopped']:
 time.sleep(2)
 for proc in report['stopped']:
  check=subprocess.run(['ps','-p',str(proc['pid']),'-o','command='],capture_output=True,text=True)
  if check.stdout.strip()==proc['command']:
   try:os.kill(proc['pid'],signal.SIGKILL)
   except ProcessLookupError:pass
 time.sleep(.2)
build=app/'native/build';keep={'gpuix-native.darwin-arm64.node','kybern-webview.dylib'}
paths=[app/'node_modules',root/'apps/desktop/node_modules',app/'native/upstream',data,app/'perf/explorer/wheel.dylib']
if build.exists():paths.extend(p for p in build.iterdir() if p.name not in keep)
# Refuse to remove anything held by another process, including an IDE/build.
for p in paths:
 if not p.exists() and not p.is_symlink():continue
 args=['lsof','-t']+(['+D',str(p)] if p.is_dir() and not p.is_symlink() else [str(p)])
 check=subprocess.run(args,capture_output=True,text=True,timeout=45)
 if check.stdout.strip():raise RuntimeError('Open files prevent cleanup: '+str(p)+' '+check.stdout.strip())
for p in paths:
 if not p.exists() and not p.is_symlink():continue
 size=subprocess.run(['du','-sk',str(p)],capture_output=True,text=True).stdout.split()
 report['removed'].append({'path':str(p),'logicalKiB':int(size[0]) if size else None})
 if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
 else:p.unlink()
report['freeAfterBytes']=free();report['retained']=[{'path':str(p),'bytes':p.stat().st_size,'reason':'validated native runtime deliverable'} for p in build.iterdir() if p.name in keep]
report['note']='Shared APFS volume; before/after free space also reflects other lanes and snapshots.'
(out/'cleanup.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
