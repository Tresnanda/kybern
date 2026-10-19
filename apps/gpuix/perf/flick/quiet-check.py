"""Exercise quiet.ts interruption with isolated coordinator files and no UI."""
import json,os,pathlib,signal,subprocess,tempfile,time
app=pathlib.Path(__file__).resolve().parents[2]
quiet=app/'perf/flick/quiet.ts'
for sig in [signal.SIGTERM,signal.SIGINT]:
 with tempfile.TemporaryDirectory(prefix='flick-quiet-check-') as directory:
  root=pathlib.Path(directory);pids=root/'pids.json';entry=root/'entry.ts'
  child="const c=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)']); require('node:fs').writeFileSync("+json.dumps(str(pids))+",JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)"
  entry.write_text("import {readFileSync} from 'node:fs';\nBun.plugin({name:'isolated-quiet',setup(build){build.onLoad({filter:/\\/perf\\/flick\\/quiet\\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replaceAll('/tmp',"+json.dumps(directory)+"),loader:'ts'}))}});\nprocess.argv=[process.execPath,"+json.dumps(str(quiet))+",process.execPath,'-e',"+json.dumps(child)+"];await import("+json.dumps(str(quiet))+");\n")
  wrapper=subprocess.Popen(['bun',str(entry)],cwd=app,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  owned=[]
  try:
   deadline=time.time()+15
   while not pids.exists():
    if wrapper.poll() is not None:raise RuntimeError(wrapper.stdout.read())
    if time.time()>deadline:raise RuntimeError('No child process started')
    time.sleep(.05)
   owned=json.loads(pids.read_text());assert (root/'kybern-gpuix-quiet.perf-flick').exists()
   wrapper.send_signal(sig);output=wrapper.communicate(timeout=10)[0]
   deadline=time.time()+5
   def alive(pid):
    row=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
    return bool(row) and not row.startswith('Z')
   while any(alive(pid) for pid in owned) and time.time()<deadline:time.sleep(.05)
   assert not any(alive(pid) for pid in owned),(owned,output)
   assert not (root/'kybern-gpuix-quiet.perf-flick').exists(),output
   assert not (root/'kybern-gpuix-quiet-order').read_text().strip(),output
   print('PASS',sig.name,'stops descendants and releases only isolated files')
  finally:
   if wrapper.poll() is None:wrapper.kill();wrapper.wait()
   for pid in owned:
    try:os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
