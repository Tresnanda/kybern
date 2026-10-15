import subprocess,time,pathlib
root=pathlib.Path(__file__).resolve().parents[1];out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16')
while 'audit-sequence.py' in subprocess.run(['ps','-p','37386','-o','command='],capture_output=True,text=True).stdout:time.sleep(3)
for cmd,name in [(['python3','scripts/audit-extras.py'],'extras-resumed'),(['python3','scripts/audit-followups.py'],'followups-progress'),(['python3','scripts/audit-state-metrics.py'],'state-metrics')]:
 print('START',name,flush=True)
 with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,cwd=root,stdout=f,stderr=subprocess.STDOUT)
 print('END',name,r.returncode,flush=True)
