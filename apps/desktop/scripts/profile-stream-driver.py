#!/usr/bin/env python3
"""Offline Claude-shaped event source for isolated memory profiling only.

Configure a scratch daemon provider binary to this executable. PROFILE_STREAM
emits 500 numbered Unicode deltas at 20 ms intervals plus the exact canonical
message. This exercises the real driver/store/socket/UI without network access;
it is not a substitute for live provider integration tests.
"""
import json
import sys
import time

def emit(value):
 print(json.dumps(value, ensure_ascii=False), flush=True)
if '--version' in sys.argv:
 print('2.1.90 (deterministic profiling fixture)'); sys.exit(0)
if '--help' in sys.argv:
 print('Deterministic offline streaming fixture'); sys.exit(0)
if 'auth' in sys.argv:
 emit({'loggedIn': True, 'authMethod': 'fixture'}); sys.exit(0)
for line in sys.stdin:
 try: frame=json.loads(line)
 except ValueError: continue
 if frame.get('type') == 'control_request':
  emit({'type':'control_response','response':{'subtype':'success','request_id':frame['request_id'],'response':{}}})
 elif frame.get('type') == 'user':
  content=json.dumps(frame.get('message',{}), ensure_ascii=False)
  if 'PROFILE_STREAM' not in content:
   emit({'type':'result','subtype':'success','is_error':False,'result':'Fixture ready','usage':{'input_tokens':0,'output_tokens':0},'duration_ms':0,'total_cost_usd':0})
   continue
  message='profile-stream-message'
  emit({'type':'stream_event','event':{'type':'message_start','message':{'id':message}}})
  chunks=[]
  for i in range(500):
   chunk=f'Profile stream {i:03d} é😀.\n'
   chunks.append(chunk)
   emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':chunk}}})
   time.sleep(.02)
  emit({'type':'assistant','uuid':'profile-assistant','message':{'id':message,'role':'assistant','model':'profile-fixture','content':[{'type':'text','text':''.join(chunks)}],'usage':{'input_tokens':20,'output_tokens':500}}})
  emit({'type':'result','subtype':'success','is_error':False,'result':''.join(chunks),'usage':{'input_tokens':20,'output_tokens':500},'duration_ms':10000,'total_cost_usd':0})
