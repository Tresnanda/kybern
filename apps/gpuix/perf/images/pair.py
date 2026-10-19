"""Run the final startup/scroll/idle A/B suite in this lane's quiet turn."""
from pathlib import Path
import os
import json
import shutil
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[4]
app = root / 'apps/gpuix'
tmp = Path('/tmp')
lane = 'perf-images'
order = tmp / 'kybern-gpuix-quiet-order'
quiet = tmp / f'kybern-gpuix-quiet.{lane}'
queue = tmp / 'kybern-gpuix-ui-queue'
evidence = Path(os.environ.get('KYBERN_MEMORY_EVIDENCE', '/Users/mymac/projects/ade/previews/gpuix/perf/images'))
data = Path(os.environ['KYBERN_DATA_DIR'])
assert 'scratch' in str(data) and data.resolve() != Path.home() / '.kybern'
child = None
owned = False

def lines(file):
    return [line.strip() for line in file.read_text().splitlines() if line.strip()] if file.exists() else []

def cancelled(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
waiting = lines(order)
if lane not in waiting:
    order.write_text('\n'.join([*waiting, lane]) + '\n')
try:
    while (lines(order)[:1] != [lane] or list(tmp.glob('kybern-gpuix-quiet.*'))
           or list(tmp.glob('kybern-gpuix-native-build.*')) or list(tmp.glob('kybern-gpuix-build-next.*'))):
        time.sleep(1)
    quiet.write_text(f'{lane} {time.time()} expected duration <25 minutes\n')
    owned = True
    started = time.monotonic()
    mode = sys.argv[1]
    label = sys.argv[2]
    addon = app / 'native/build/gpuix-native.darwin-arm64.node'
    # The archived control predates hidden-display placement. Use its explicit
    # same-binary legacy switches so every A/B opens on the test display.
    legacy = {'KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY': '0', 'KYBERN_IMAGE_FRAME_MOVE': '0'}
    jobs = [(label, ['bun', 'perf/memory/' + ('visual.ts' if mode == 'visual' else 'lab-run.ts'), label],
             {'NAPI_RS_NATIVE_LIBRARY_PATH': str(addon), 'KYBERN_MEMORY_LANE': lane,
              **({'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_MEMORY_HEAP': '1',
                  **({'KYBERN_MEMORY_STACKS': '1'} if mode == 'stacks' else {})} if mode in ['stacks', 'note'] else {})})]
    if mode == 'baseline':
        common = {'NAPI_RS_NATIVE_LIBRARY_PATH': str(addon), 'KYBERN_MEMORY_LANE': lane, **legacy}
        jobs = [
            ('before-note-stacks', ['bun', 'perf/memory/lab-run.ts', 'before-note-stacks'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_MEMORY_HEAP': '1', 'KYBERN_MEMORY_STACKS': '1'}),
            ('before-note', ['bun', 'perf/memory/lab-run.ts', 'before-note'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_MEMORY_HEAP': '1'}),
            ('before-lab', ['bun', 'perf/memory/lab-run.ts', 'before-lab'], common),
            ('before-final', ['bun', 'perf/memory/visual.ts', 'before-final'], common),
        ]
    if mode == 'final':
        common = {'NAPI_RS_NATIVE_LIBRARY_PATH': str(addon), 'KYBERN_MEMORY_LANE': lane}
        product = {'KYBERN_DATA_DIR': str(data) + '-product', 'KYBERN_MEMORY_GROUPS': 'image-thread', 'KYBERN_MEMORY_IMAGE_THREAD': '1'}
        jobs = [
            ('control-legacy-note', ['bun', 'perf/memory/lab-run.ts', 'control-legacy-note'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY': '0', 'KYBERN_IMAGE_FRAME_MOVE': '0'}),
            ('control-owner-note', ['bun', 'perf/memory/lab-run.ts', 'control-owner-note'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_IMAGE_FRAME_MOVE': '0'}),
            ('after-note', ['bun', 'perf/memory/lab-run.ts', 'after-note'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_MEMORY_EDITOR_ROUNDS': '2', 'KYBERN_MEMORY_HEAP': '1'}),
            ('after-lab', ['bun', 'perf/memory/lab-run.ts', 'after-lab'], common),
            ('before-thread', ['bun', 'perf/memory/run.ts', 'before-thread'], {**common, **product, **legacy}),
            ('after-thread', ['bun', 'perf/memory/run.ts', 'after-thread'], {**common, **product}),
            ('after-final', ['bun', 'perf/memory/visual.ts', 'after-final'], common),
            ('visual-diff', ['bun', 'perf/images/visual-diff.ts'], common),
            ('lightbox-before', ['bun', 'perf/images/verify-run.ts'], {**common, **legacy, 'KYBERN_IMAGE_VERIFY_LABEL': 'before'}),
            ('lightbox-after', ['bun', 'perf/images/verify-run.ts'], {**common, 'KYBERN_IMAGE_VERIFY_LABEL': 'after'}),
            ('lightbox-diff', ['bun', 'perf/images/visual-diff.ts', '--lightbox'], common),
            ('src-tests', ['bun', '-e', r"const {lease}=await import('./perf/memory/lease.ts');const release=await lease();try{const test=Bun.spawn(['bun','test','./src'],{env:{...process.env,KYBERN_PACING_PARENT_LEASE:process.cwd().replace(/\/apps\/gpuix$/,'')},stdout:'inherit',stderr:'inherit'});process.exitCode=await test.exited}finally{release()}"], common),
            ('after-note-stacks', ['bun', 'perf/memory/lab-run.ts', 'after-note-stacks'], {**common, 'KYBERN_MEMORY_EDITOR_MANY': '1', 'KYBERN_MEMORY_EDITOR_EDITABLE': '1', 'KYBERN_MEMORY_HEAP': '1', 'KYBERN_MEMORY_STACKS': '1'}),
        ]
    for label, command, extra in jobs:
        env = dict(os.environ, KYBERN_DATA_DIR=str(data), KYBERN_CLIENT_CONFIG_DIR=str(data / 'client'),
                   KYBERN_URL='', KYBERN_TOKEN='', KYBERN_BENCH_PORT='4340',
                   KYBERN_MEMORY_EVIDENCE=str(evidence), KYBERN_BENCH_EVIDENCE=str(evidence), KYBERN_FULL_RATE='1', GPUIX_BACKGROUND='1')
        env.update(extra)
        if '--memory' in sys.argv and 'NAPI_RS_NATIVE_LIBRARY_PATH' not in extra:
            env.pop('NAPI_RS_NATIVE_LIBRARY_PATH', None)
        with (evidence / f'{label}.log').open('w') as log:
            child = subprocess.Popen(command, cwd=app, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                assert time.monotonic() - started < (24.8 if '--memory' in sys.argv else 24) * 60, 'Quiet-window limit'
                # The current quiet holder gets the next lease. Mutate only
                # our runner's line, leaving the current holder in first place.
                own = f'perf-bench-{child.pid}'
                entries = lines(queue)
                if own in entries and entries.index(own) > 1:
                    entries.remove(own)
                    entries.insert(1, own)
                    queue.write_text('\n'.join(entries) + '\n')
                time.sleep(1)
            assert child.returncode == 0, f'{label}: see {log.name}'

finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    if owned:
        quiet.unlink(missing_ok=True)
    remaining = [line for line in lines(order) if line != lane]
    order.write_text('\n'.join(remaining) + ('\n' if remaining else ''))
