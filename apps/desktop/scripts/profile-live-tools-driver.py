#!/usr/bin/env python3
"""Offline Claude-shaped live-result workload for an isolated scratch daemon."""
import json
import sys
import time

def emit(frame):
    print(json.dumps(frame, ensure_ascii=False), flush=True)

if "--version" in sys.argv:
    print("2.1.90 (offline live-result fixture)"); sys.exit(0)
if "--help" in sys.argv:
    print("Offline native memory fixture"); sys.exit(0)
if "auth" in sys.argv:
    emit({"loggedIn": True, "authMethod": "fixture"}); sys.exit(0)
for line in sys.stdin:
    try: frame = json.loads(line)
    except ValueError: continue
    if frame.get("type") == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": frame["request_id"], "response": {}}})
    elif frame.get("type") == "user":
        emit({"type": "system", "subtype": "init", "session_id": "live-tool-fixture", "tools": []})
        for i in range(64):
            call = f"live-{i:03d}"
            emit({"type": "assistant", "message": {"id": f"message-{i}", "role": "assistant", "content": [{"type": "tool_use", "id": call, "name": "Read", "input": {"file_path": f"/fixture/{call}.txt"}}]}})
            output = f"Result {i:03d}: é😀\n" + f"{i:03d} exact payload\n" * 65536
            emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": call, "content": output, "is_error": True}]}})
            time.sleep(0.05)
        emit({"type": "result", "subtype": "success", "session_id": "live-tool-fixture", "is_error": False, "result": "Completed 64 exact results.", "usage": {"input_tokens": 0, "output_tokens": 0}, "duration_ms": 4000, "total_cost_usd": 0})
