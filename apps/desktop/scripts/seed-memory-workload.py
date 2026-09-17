import json, sqlite3, sys, uuid
from pathlib import Path
root=Path(sys.argv[1]).resolve()
if '.scratch' not in root.parts: raise ValueError('Use an isolated .scratch directory')
db=sqlite3.connect(root/'state.sqlite')
project='10000000-0000-4000-8000-000000000001'; thread='20000000-0000-4000-8000-000000000001'
at='2026-09-17T00:00:00Z'
db.execute("INSERT INTO projects(id,name,path,is_git,created_at,updated_at) VALUES (?,?,?,0,?,?)",(project,'Sanitized memory workload',str(root),at,at))
db.execute("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'codex','default','supervised','idle',?,?,?)",(thread,project,'400 turns / 800 large tools',str(root),at,at))
seq=0
def event(turn,kind,**kw):
 global seq
 seq+=1
 db.execute('INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?,?)',(seq,thread,turn,at,kind,json.dumps(dict(kind=kind,**kw),ensure_ascii=False)))
for n in range(400):
 turn=str(uuid.UUID(int=10000+n)); msg=str(uuid.UUID(int=20000+n))
 event(turn,'turn_started',message_id=str(uuid.UUID(int=30000+n)),message={'parts':[{'type':'text','text':f'Review sanitized example {n}'}]})
 event(turn,'assistant_text_delta',message_id=msg,delta='Inspecting files. ',origin={'kind':'root'})
 for k in range(2):
  call=f'tool-{n}-{k}'
  event(turn,'tool_call_started',call={'id':call,'name':'Read','input':{'file_path':f'/example/file-{n}-{k}.ts'}},origin={'kind':'root'})
  for _ in range(4): event(turn,'tool_call_output_delta',tool_call_id=call,delta='progress é😀\n'*256)
  event(turn,'tool_call_completed',tool_call_id=call,output={'stdout':f'file {n}-{k}\n'+'const value = "é😀";\n'*3000},is_error=False)
 event(turn,'assistant_message_completed',message_id=msg,origin={'kind':'root'},text='Inspecting files. Finished.\n\n| Key | Value |\n| --- | --- |\n| Unicode | é😀 |',thinking=None)
 event(turn,'turn_completed',stop_reason='completed',usage={'input_tokens':50,'output_tokens':50},cost_usd=None,duration_ms=100,terminal_message_id=msg)
db.execute('UPDATE threads SET last_seq=? WHERE id=?',(seq,thread)); db.commit(); db.close()
(root/'fixture.json').write_text(json.dumps({'thread_id':thread,'events':seq,'turns':400,'tools':800}))
print(json.dumps({'events':seq,'turns':400,'tools':800}))
