"""Real Kybern/Pi smoke test with a loopback-only deterministic model server.

Usage: python3 pi_release_smoke.py /path/to/kybernd /path/to/pi
No provider credentials or external inference service are used.
"""
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "target/debug/kybern"
DAEMON = Path(sys.argv[1]).resolve()
PI = Path(sys.argv[2]).absolute()
REQUESTS = []
ERRORS = []
BLOCKED = threading.Event()
RELEASE = threading.Event()


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            REQUESTS.append(body)
            messages = body["messages"]
            user_index = max(i for i, item in enumerate(messages) if item["role"] == "user")
            marker = str(messages[user_index]["content"])
            stage = sum(item["role"] == "tool" for item in messages[user_index + 1 :])
            suffix = "deny" if "smoke-deny" in marker else "allow"
            tool = None
            if "smoke-hold" in marker or "smoke-stop" in marker:
                BLOCKED.set()
                assert RELEASE.wait(15), "test server was not released"
            elif "smoke-steer" in marker:
                pass
            elif stage == 0:
                tool = ("kybern_thread_context", {})
            elif stage == 1:
                tool = ("write", {"path": f"{suffix}.txt", "content": "written by real Pi"})
            elif stage == 2:
                tool = ("kybern_read_file", {"path": "fixture.txt"})
            if tool:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"smoke-{suffix}-{stage}", "type": "function", "function": {"name": tool[0], "arguments": json.dumps(tool[1])}}]}
                reason = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "Release smoke complete"}
                reason = "stop"
            frame = {"id": "local-smoke", "object": "chat.completion.chunk", "created": 1, "model": "local", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
            end = {"id": "local-smoke", "object": "chat.completion.chunk", "created": 1, "model": "local", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}
            data = ("data: " + json.dumps(frame) + "\n\ndata: " + json.dumps(end) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The cancellation check deliberately closes the active stream.
        except Exception as error:
            ERRORS.append(str(error))


with tempfile.TemporaryDirectory(prefix="kybern-pi-release-") as scratch:
    scratch = Path(scratch)
    project = scratch / "project"
    agent = scratch / "pi-agent"
    data = scratch / "daemon"
    for folder in (project, agent, data):
        folder.mkdir()
    (project / "fixture.txt").write_text("file bridge verified")
    project_extensions = project / ".pi/extensions"
    project_extensions.mkdir(parents=True)
    trust_marker = project / "untrusted-extension-ran"
    (project_extensions / "trust-test.ts").write_text('import { writeFileSync } from "node:fs"; export default function () { writeFileSync(' + json.dumps(str(trust_marker)) + ', "true"); }')
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (agent / "models.json").write_text(json.dumps({"providers": {"smoke": {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "local-smoke-placeholder", "models": [{"id": "local", "name": "Local smoke", "reasoning": True, "contextWindow": 128000, "maxTokens": 4096}]}}}))
    (agent / "settings.json").write_text(json.dumps({"defaultProvider": "smoke", "defaultModel": "local", "defaultThinkingLevel": "low", "enableInstallTelemetry": False}))
    pi_env = {"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
    (data / "settings.json").write_text(json.dumps({"default_provider": "pi", "generate_titles": False, "auto_update_daemon": False, "auto_update_harnesses": False, "providers": {"pi": {"binary": str(PI), "model": "smoke/local", "env": pi_env}}}))
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ}
    env["RUST_LOG"] = "warn"
    log = (scratch / "daemon.log").open("w+")
    daemon = None

    def start():
        global daemon
        for filename in ("daemon.port", "daemon.token"):
            (data / filename).unlink(missing_ok=True)
        daemon = subprocess.Popen([str(DAEMON), "--data-dir", str(data), "--port", "0"], env=env, stdout=log, stderr=log, start_new_session=True)
        until = time.monotonic() + 20
        while not (data / "daemon.port").exists():
            assert daemon.poll() is None, "scratch daemon exited"
            assert time.monotonic() < until, "scratch daemon did not start"
            time.sleep(.05)

    def stop():
        if daemon and daemon.poll() is None:
            daemon.send_signal(signal.SIGTERM)
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(daemon.pid, signal.SIGKILL)
                daemon.wait(timeout=5)

    def rpc(method, params):
        result = subprocess.run([str(CLI), "--data-dir", str(data), "call", method, json.dumps(params)], env=env, capture_output=True, text=True, timeout=25)
        assert result.returncode == 0, f"{method}: {result.stderr}"
        return json.loads(result.stdout)

    def run_turn(thread, marker, decision=None):
        start_request = len(REQUESTS)
        rpc("threads.send", {"thread_id": thread, "message": {"parts": [{"type": "text", "text": marker}]}})
        until = time.monotonic() + 35
        approvals = 0
        while time.monotonic() < until:
            state = rpc("threads.get", {"thread_id": thread})
            for approval in state["pending_approvals"]:
                assert decision, f"unexpected approval: {approval}"
                assert approval["tool_name"] == "write", approval
                assert not (project / ("deny.txt" if decision == "deny" else "allow.txt")).exists(), "write executed before approval"
                rpc("approvals.respond", {"approval_id": approval["id"], "decision": decision})
                approvals += 1
            status = state["thread"]["status"]
            assert status != "failed", json.dumps(state)
            if status == "idle":
                serialized = json.dumps(state["transcript"])
                assert "Release smoke complete" in serialized, serialized
                assert "file bridge verified" in serialized, serialized
                recent = REQUESTS[start_request:]
                assert len(recent) == 4, len(recent)
                all_messages = json.dumps(recent[-1]["messages"])
                assert thread in all_messages and "release note fixture" in all_messages, "app context did not reach real Pi"
                assert approvals == (1 if decision else 0), approvals
                return state
            time.sleep(.05)
        raise AssertionError("real Pi turn did not settle")

    def wait_idle(thread):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            state = rpc("threads.get", {"thread_id": thread})
            assert state["thread"]["status"] != "failed", json.dumps(state)
            if state["thread"]["status"] == "idle":
                return state
            time.sleep(.05)
        raise AssertionError("turn did not settle after steering/stop")

    try:
        start()
        project_id = rpc("projects.add", {"path": str(project), "name": "Pi release smoke"})["id"]
        thread = rpc("threads.create", {"project_id": project_id, "provider": {"kind": "pi", "instance": "default"}, "permission_mode": "supervised", "model": "smoke/local", "effort": "low", "title": "Pi smoke", "use_worktree": False})["id"]
        rpc("threads.notes.set", {"thread_id": thread, "text": "release note fixture", "expected_revision": 0})
        first = run_turn(thread, "smoke-deny", "deny")
        assert not (project / "deny.txt").exists(), "denial failed to block native write"
        assert not trust_marker.exists(), "Kybern overrode Pi project trust and executed a project-local extension"
        assert REQUESTS[0].get("reasoning_effort") == "low", "initial thinking level did not reach Pi's model request"
        print("PASS supervised denial, app tools, native settlement", flush=True)
        rpc("threads.update", {"thread_id": thread, "effort": "high"})
        second = run_turn(thread, "smoke-allow", "allow_once")
        assert REQUESTS[-1].get("reasoning_effort") == "high", "changed thinking level did not reach Pi's model request"
        assert (project / "allow.txt").read_text() == "written by real Pi"
        assert first["thread"]["provider_session_id"] == second["thread"]["provider_session_id"]
        print("PASS live effort switch and allow-once native write", flush=True)
        (project / "allow.txt").unlink()
        rpc("threads.update", {"thread_id": thread, "permission_mode": "accept-edits"})
        run_turn(thread, "smoke-allow edits")
        assert (project / "allow.txt").exists()
        print("PASS live Accept edits mode", flush=True)
        (project / "allow.txt").unlink()
        rpc("threads.update", {"thread_id": thread, "permission_mode": "full-access"})
        run_turn(thread, "smoke-allow full")
        assert (project / "allow.txt").exists()
        print("PASS live Full access mode", flush=True)
        start_request = len(REQUESTS)
        rpc("threads.send", {"thread_id": thread, "message": {"parts": [{"type": "text", "text": "smoke-hold"}]}})
        assert BLOCKED.wait(10), "Pi did not start the held turn"
        rpc("threads.steer", {"id": str(uuid.uuid4()), "thread_id": thread, "message": {"parts": [{"type": "text", "text": "smoke-steer"}]}})
        RELEASE.set()
        wait_idle(thread)
        recent = REQUESTS[start_request:]
        assert len(recent) == 2 and "smoke-steer" in json.dumps(recent[-1]["messages"]), "steering did not execute in the same run"
        print("PASS native streaming steer and settlement", flush=True)
        BLOCKED.clear()
        RELEASE.clear()
        rpc("threads.send", {"thread_id": thread, "message": {"parts": [{"type": "text", "text": "smoke-stop"}]}})
        assert BLOCKED.wait(10), "Pi did not start the interruptible turn"
        rpc("threads.interrupt", {"thread_id": thread})
        RELEASE.set()
        stopped = wait_idle(thread)
        assert not stopped["pending_approvals"]
        print("PASS native streaming cancellation", flush=True)
        (project / "allow.txt").unlink()
        stop()
        start()
        resumed = run_turn(thread, "smoke-allow resume")
        assert resumed["thread"]["provider_session_id"] == first["thread"]["provider_session_id"]
        assert (project / "allow.txt").exists()
        print("PASS persisted Pi session resume after daemon restart", flush=True)
        assert not ERRORS, ERRORS
    finally:
        RELEASE.set()
        stop()
        server.shutdown()
        log.flush()
        if sys.exc_info()[0]:
            log.seek(0)
            print(log.read()[-12000:], file=sys.stderr)
        log.close()
