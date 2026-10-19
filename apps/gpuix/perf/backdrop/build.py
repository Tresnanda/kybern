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
lane = "perf-backdrop"
reservation = tmp / f"kybern-gpuix-build-next.{lane}"
marker = tmp / f"kybern-gpuix-native-build.{lane}"
log = Path("/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/native-update.log")
child = None
reserved = False
routing = []
awake = None
screen_script = '/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'

def screen_ready():
    result=subprocess.run(['swift',screen_script],capture_output=True,text=True)
    import re
    return result.returncode==0 and bool(re.search(r'locked:\s*0\b',result.stdout)) and bool(re.search(r'displayAsleep:\s*(?:0|false)\b',result.stdout))

def cancelled(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
try:
    finish_only = "--finish-checks" in sys.argv or "--compositor-only" in sys.argv or "--stream-visual-only" in sys.argv
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
    import shutil
    if shutil.disk_usage(root).free < 30*1024**3: raise RuntimeError("Need 30 GiB free")
    while True:
        if list(tmp.glob("kybern-gpuix-quiet.*")) or list(tmp.glob("kybern-gpuix-native-build.*")):
            time.sleep(1);continue
        if not screen_ready(): time.sleep(60);continue
        if list(tmp.glob("kybern-gpuix-quiet.*")) or list(tmp.glob("kybern-gpuix-native-build.*")): continue
        marker.write_text(f"{lane} {time.time()}\n")
        conflict=lambda: list(tmp.glob("kybern-gpuix-quiet.*")) or [p for p in tmp.glob("kybern-gpuix-native-build.*") if p != marker]
        if conflict(): marker.unlink(missing_ok=True);time.sleep(1);continue
        time.sleep(.3)
        if conflict(): marker.unlink(missing_ok=True);time.sleep(1);continue
        break
    awake=subprocess.Popen(['/usr/bin/caffeinate','-d','-w',str(os.getpid())])
    (app / "native/build/backdrop-final-pending").write_text("Full updater pending\n")
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
    baseline=app/"native/build/backdrop-before.node"
    if not baseline.exists(): shutil.copy2(addon,baseline)
    env = dict(os.environ, KYBERN_DATA_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop",
               KYBERN_CLIENT_CONFIG_DIR="/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop/native-client",
               KYBERN_URL="", KYBERN_TOKEN="", RUSTC_WRAPPER="", CARGO_INCREMENTAL="0",
               CARGO_BUILD_JOBS="4", CARGO_TARGET_DIR=str(app / "native/build/target"),
               KYBERN_VERIFY_OUTPUT="/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/native-checks")
    Path(env["KYBERN_CLIENT_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    env['KYBERN_WINDOW_GUARD']=str(app/'native/build/backdrop-window-guard')
    env['BUN_OPTIONS']='--preload='+str(app/'perf/backdrop/capture-preload.ts')
    env['PATH']=str(app/'perf/backdrop')+os.pathsep+env['PATH']
    with log.open("a" if finish_only else "w") as output:
        commands = [["swiftc", "perf/backdrop/window-guard.swift", "-o", env["KYBERN_WINDOW_GUARD"]], ["clang", "-dynamiclib", "-fobjc-arc", "-framework", "Cocoa", "-framework", "CoreGraphics", "perf/explorer/wheel.m", "-o", str(app/"native/build/gpu-wheel.dylib")],
                    ["nice", "-n", "15", "sh", "native/update.sh"],
                    ["pnpm", "exec", "tsc", "-p", "native/tsconfig.json"],
                    ["rustc", "--edition=2021", "--test", "native/patches/backdrop_kernel.rs", "-o", "native/build/backdrop-kernel-tests"],
                    ["native/build/backdrop-kernel-tests"],
                    ["bun", "native/ui-lease.ts", "backdrop-kernel", "bun", "perf/backdrop/kernel-check.ts"],
                    ["bun", "native/ui-lease.ts", "backdrop-stream-visual", "bun", "perf/backdrop/stream-visual.ts"],
                    ["bun", "native/ui-lease.ts", "backdrop-product-pairs", "bun", "perf/backdrop/product-visual.ts", "pairs"],
                    ["bun", "native/ui-lease.ts", "backdrop-accessibility", "bun", "perf/backdrop/product-visual.ts", "accessibility"],
                    ["bun", "native/ui-lease.ts", "backdrop-compositor", "bun", "perf/backdrop/compositor.ts"]]
        if "--stream-visual-only" in sys.argv: commands = [["bun", "native/ui-lease.ts", "backdrop-stream-visual", "bun", "perf/backdrop/stream-visual.ts"]]
        elif "--compositor-only" in sys.argv: commands = commands[-1:]
        elif finish_only: commands = commands[3:]
        for command in commands:
            if not screen_ready(): raise RuntimeError('Locked/asleep: pause native UI validation')
            child = subprocess.Popen(command, cwd=app, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                time.sleep(1)
            if child.returncode:
                sys.exit(child.returncode)
            if not screen_ready(): raise RuntimeError('Locked/asleep after native validation: discard')
        (app / "native/build/backdrop-final-pending").unlink(missing_ok=True)

finally:
    if awake is not None:
        awake.terminate()
        awake.wait()
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
