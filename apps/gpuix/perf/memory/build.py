"""Reserve/build at low priority, with no Cargo/quiet overlap and owned cleanup."""
from pathlib import Path
import os
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[4]
app = root / "apps/gpuix"
tmp = Path("/tmp")
lane = "perf-memory"
reservation = tmp / f"kybern-gpuix-build-next.{lane}"
marker = tmp / f"kybern-gpuix-native-build.{lane}"
log = Path("/Users/mymac/projects/ade/previews/gpuix/perf/memory/native-update.log")
child = None
reserved = False

def cancelled(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
try:
    if len(sys.argv) > 1:
        pid = int(sys.argv[1])
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(1)
    while (list(tmp.glob("kybern-gpuix-quiet.*")) or
           [p for p in tmp.glob("kybern-gpuix-build-next.*") if p != reservation]):
        time.sleep(1)
    reservation.write_text(f"{lane} {time.time()}\n")
    reserved = True
    while list(tmp.glob("kybern-gpuix-quiet.*")):
        time.sleep(1)
    marker.write_text(f"{lane} {time.time()}\n")
    env = dict(os.environ, KYBERN_DATA_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-memory",
               KYBERN_CLIENT_CONFIG_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-memory/native-client",
               KYBERN_URL="", KYBERN_TOKEN="", RUSTC_WRAPPER="", CARGO_INCREMENTAL="0",
               CARGO_BUILD_JOBS="4", CARGO_TARGET_DIR=str(app / "native/build/target"),
               KYBERN_VERIFY_OUTPUT="/Users/mymac/projects/ade/previews/gpuix/perf/memory/native-checks")
    Path(env["KYBERN_CLIENT_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        commands = [["nice", "-n", "15", "sh", "native/update.sh"],
                    ["pnpm", "exec", "tsc", "-p", "native/tsconfig.json"],
                    ["pnpm", "exec", "tsc", "-p", "perf/memory/tsconfig.json"]]
        for command in commands:
            child = subprocess.Popen(command, cwd=app, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                time.sleep(1)
            if child.returncode:
                sys.exit(child.returncode)
        (app / "native/build/memory-final-pending").unlink(missing_ok=True)

finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    marker.unlink(missing_ok=True)
    if reserved:
        reservation.unlink(missing_ok=True)
