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
lane = "perf-images"
reservation = tmp / f"kybern-gpuix-build-next.{lane}"
marker = tmp / f"kybern-gpuix-native-build.{lane}"
log = Path("/Users/mymac/projects/ade/previews/gpuix/perf/images/native-update.log")
child = None
reserved = False

def cancelled(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
try:
    frames_only = sys.argv[1:] == ['--frames-only']
    if len(sys.argv) > 1 and not frames_only:
        pid = int(sys.argv[1])
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(1)
    # Reserve while a build/quiet window is active, as the shared fairness
    # contract permits. Waiting for total idleness before reserving can starve
    # this lane behind each new quiet window. Only one next-build slot exists.
    while [p for p in tmp.glob("kybern-gpuix-build-next.*") if p != reservation]:
        time.sleep(1)
    reservation.write_text(f"{lane} {time.time()}\n")
    reserved = True
    while list(tmp.glob("kybern-gpuix-quiet.*")) or list(tmp.glob("kybern-gpuix-native-build.*")):
        time.sleep(1)
    if os.statvfs(root).f_bavail * os.statvfs(root).f_frsize < 30 * 1024**3:
        raise RuntimeError('Less than 30 GiB available; pause disk-heavy work')
    while True:
        state = subprocess.check_output(['swift', '/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'], text=True)
        if 'locked: 0' in state and 'testDisplay: ready' in state and ('displayAsleep: 0' in state or 'displayAsleep: false' in state):
            break
        time.sleep(60)
    # Screen checks can take long enough for another lane to acquire quiet.
    # Keep the reservation while waiting; recheck immediately before marking.
    while list(tmp.glob("kybern-gpuix-quiet.*")):
        time.sleep(1)
    marker.write_text(f"{lane} {time.time()}\n")
    reservation.unlink(missing_ok=True)
    reserved = False
    env = dict(os.environ, KYBERN_DATA_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-images-native",
               KYBERN_CLIENT_CONFIG_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-images-native/native-client",
               KYBERN_URL="", KYBERN_TOKEN="", RUSTC_WRAPPER="", CARGO_INCREMENTAL="0",
               CARGO_BUILD_JOBS="4", CARGO_TARGET_DIR=str(app / "native/build/target"),
               KYBERN_VERIFY_OUTPUT="/Users/mymac/projects/ade/previews/gpuix/perf/images/native-checks")
    Path(env["KYBERN_CLIENT_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    awake = subprocess.Popen(['caffeinate', '-d', '-w', str(os.getpid())])
    output_log = log.with_name('frame-checks.log') if frames_only else log
    with output_log.open("w") as output:
        output.write(state)
        output.flush()
        commands = ([] if frames_only else [["nice", "-n", "15", "sh", "native/update.sh"]]) + [
                    ["python3", "perf/images/check-frames.py"],
                    ["pnpm", "exec", "tsc", "-p", "native/tsconfig.json"],
                    ["pnpm", "exec", "tsc", "-p", "perf/images/tsconfig.json"]]
        for command in commands:
            child = subprocess.Popen(command, cwd=app, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                time.sleep(1)
            if child.returncode:
                sys.exit(child.returncode)
        state = subprocess.check_output(['swift', '/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'], text=True)
        output.write(state)
        if 'locked: 0' not in state or 'testDisplay: ready' not in state or not ('displayAsleep: 0' in state or 'displayAsleep: false' in state):
            raise RuntimeError('Native checks invalidated by locked/asleep display; rerun when available')
    awake.terminate()
    awake.wait()

finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    if 'awake' in globals() and awake.poll() is None:
        awake.terminate()
        awake.wait()
    marker.unlink(missing_ok=True)
    if reserved:
        reservation.unlink(missing_ok=True)
