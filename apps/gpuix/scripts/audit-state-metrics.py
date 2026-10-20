import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[1]
art=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16')
pairs=[('notes-hover','notes-gallery'),('settings-hover','settings-general'),('settings-focus','settings-general'),('pulls-hover','pulls-list'),('shell-sidebar-hover','shell-home'),('shell-new-chat-hover','shell-home'),('conversation-disabled','conversation-empty'),('conversation-subagent-hover','conversation-subagents')]
results=[]
for renderer in ['tauri','gpuix']:
 for theme in ['dark','light']:
  for state,base in pairs:
   a=art/'visual'/f'{state}-{theme}-{renderer}.png';b=art/'visual'/f'{base}-{theme}-{renderer}.png'
   if not a.exists() or not b.exists():results.append(dict(state=state,base=base,theme=theme,renderer=renderer,status='Missing capture'));continue
   r=subprocess.run(['swift',str(root/'scripts/audit-state-metrics.swift'),str(a),str(b)],capture_output=True,text=True)
   results.append(dict(state=state,base=base,theme=theme,renderer=renderer,status='Pass' if r.returncode==0 else 'Fail',**(json.loads(r.stdout) if r.returncode==0 else dict(error=r.stderr))))
(art/'state-metrics.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
