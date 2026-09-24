#!/usr/bin/env python3
"""Offline Claude-shaped replay of a recorded session for isolated memory profiling only.

Configure a scratch daemon provider binary to this executable and set
KYBERN_PERF_REPLAY_JSONL to a copy of a Claude Code session transcript. Each
PROFILE_REPLAY message streams that session's assistant text, thinking, tool
calls and tool results back through the real driver/store/socket/UI path.
Identifiers get a per-pass suffix so repeated passes stay distinct rows.
"""
import json
import os
import sys
import time

def emit(value):
 print(json.dumps(value, ensure_ascii=False), flush=True)
if '--version' in sys.argv:
 print('2.1.90 (deterministic profiling fixture)'); sys.exit(0)
if '--help' in sys.argv:
 print('Deterministic offline replay fixture'); sys.exit(0)
if 'auth' in sys.argv:
 emit({'loggedIn': True, 'authMethod': 'fixture'}); sys.exit(0)

entries = []
with open(os.environ['KYBERN_PERF_REPLAY_JSONL'], encoding='utf-8') as source:
 for line in source:
  entry = json.loads(line)
  message = entry.get('message')
  if entry.get('type') not in ('assistant', 'user') or not isinstance(message, dict) or not isinstance(message.get('content'), list):
   continue
  # Only replay provider output: assistant blocks and tool results, not prompts.
  if entry['type'] == 'user' and not any(block.get('type') == 'tool_result' for block in message['content']):
   continue
  entries.append(entry)
delta_pause = float(os.environ.get('KYBERN_PERF_REPLAY_DELTA_MS', '8')) / 1000
frame_pause = float(os.environ.get('KYBERN_PERF_REPLAY_FRAME_MS', '120')) / 1000
passes = 0

def replay(suffix):
 current = None
 for entry in entries:
  message = json.loads(json.dumps(entry['message']))
  for block in message['content']:
   if block.get('type') == 'tool_use': block['id'] = f"{block['id']}-{suffix}"
   if block.get('type') == 'tool_result': block['tool_use_id'] = f"{block['tool_use_id']}-{suffix}"
  if entry['type'] == 'assistant':
   message['id'] = f"{message.get('id', 'message')}-{suffix}"
   if message['id'] != current:
    current = message['id']
    emit({'type': 'stream_event', 'parent_tool_use_id': None, 'event': {'type': 'message_start', 'message': {'id': current}}})
   for block in message['content']:
    kind, field = ('text_delta', 'text') if block.get('type') == 'text' else ('thinking_delta', 'thinking') if block.get('type') == 'thinking' else (None, None)
    text = block.get(field) if kind else None
    for start in range(0, len(text or ''), 24):
     emit({'type': 'stream_event', 'parent_tool_use_id': None, 'event': {'type': 'content_block_delta', 'index': 0, 'delta': {'type': kind, field: text[start:start + 24]}}})
     time.sleep(delta_pause)
  emit({'type': entry['type'], 'uuid': f"{entry.get('uuid', 'entry')}-{suffix}", 'parent_tool_use_id': None, 'message': message})
  time.sleep(frame_pause)

for line in sys.stdin:
 try: frame = json.loads(line)
 except ValueError: continue
 if frame.get('type') == 'control_request':
  emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': frame['request_id'], 'response': {}}})
 elif frame.get('type') == 'user':
  if 'PROFILE_REPLAY' not in json.dumps(frame.get('message', {}), ensure_ascii=False):
   emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'Fixture ready', 'usage': {'input_tokens': 0, 'output_tokens': 0}, 'duration_ms': 0, 'total_cost_usd': 0})
   continue
  passes += 1
  replay(passes)
  emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'Replay complete', 'usage': {'input_tokens': 20, 'output_tokens': 500}, 'duration_ms': 10000, 'total_cost_usd': 0})
