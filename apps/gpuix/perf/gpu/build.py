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
lane = "perf-gpu"
reservation = tmp / f"kybern-gpuix-build-next.{lane}"
marker = tmp / f"kybern-gpuix-native-build.{lane}"
log = Path("/Users/mymac/projects/ade/previews/gpuix/perf/gpu/native-update.log")
child = None
reserved = False
routing = []

def cancelled(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
try:
    finish_only = "--finish-checks" in sys.argv
    if len(sys.argv) > 1 and not finish_only:
        pid = int(sys.argv[1])
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(1)
    while [p for p in tmp.glob("kybern-gpuix-build-next.*") if p != reservation]:
        time.sleep(1)
    reservation.write_text(f"{lane} {time.time()}\n")
    reserved = True
    while list(tmp.glob("kybern-gpuix-quiet.*")) or list(tmp.glob("kybern-gpuix-native-build.*")):
        time.sleep(1)
    import shutil
    if shutil.disk_usage(root).free < 30*1024**3: raise RuntimeError("Need 30 GiB free")
    marker.write_text(f"{lane} {time.time()}\n")
    (app / "native/build/gpu-final-pending").write_text("Full updater pending\n")
    evidence=log.parent/"native-checks"
    old="/Users/mymac/projects/ade/previews/gpuix"
    import re
    for folder in [app/"native",app/"scripts"]:
        for p in folder.glob("*.ts"):
            original=p.read_text()
            if old not in original: continue
            routing.append((p,original))
            updated=original.replace(old,str(evidence))
            p.write_text(updated)
            for raw in re.findall(re.escape(str(evidence))+r"[^'\"`\n]+",updated):
                clean=raw.split("${")[0]
                dest=Path(clean)
                (dest.parent if dest.suffix else dest).mkdir(parents=True,exist_ok=True)
    addon=app/"native/build/gpuix-native.darwin-arm64.node"
    baseline=app/"native/build/gpu-before.node"
    if not baseline.exists(): shutil.copy2(addon,baseline)
    env = dict(os.environ, KYBERN_DATA_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-gpu",
               KYBERN_CLIENT_CONFIG_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-gpu/native-client",
               KYBERN_URL="", KYBERN_TOKEN="", RUSTC_WRAPPER="", CARGO_INCREMENTAL="0",
               CARGO_BUILD_JOBS="4", CARGO_TARGET_DIR=str(app / "native/build/target"),
               KYBERN_VERIFY_OUTPUT="/Users/mymac/projects/ade/previews/gpuix/perf/gpu/native-checks")
    Path(env["KYBERN_CLIENT_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    with log.open("a" if finish_only else "w") as output:
        commands = [["clang", "-dynamiclib", "-fobjc-arc", "-framework", "Cocoa", "-framework", "CoreGraphics", "perf/explorer/wheel.m", "-o", str(app/"native/build/gpu-wheel.dylib")],
                    ["nice", "-n", "15", "sh", "native/update.sh"],
                    ["pnpm", "exec", "tsc", "-p", "native/tsconfig.json"],
                    ["rustc", "--edition=2021", "--test", "native/patches/gpu_clip_bounds.rs", "-o", "native/build/gpu-clip-tests"],
                    ["native/build/gpu-clip-tests"]]
        if finish_only: commands = commands[2:]
        for command in commands:
            child = subprocess.Popen(command, cwd=app, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                time.sleep(1)
            if child.returncode:
                sys.exit(child.returncode)
        (app / "native/build/gpu-final-pending").unlink(missing_ok=True)

finally:
    for p,original in routing: p.write_text(original)
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
