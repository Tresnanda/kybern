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
lane = 'perf-memory'
order = tmp / 'kybern-gpuix-quiet-order'
quiet = tmp / f'kybern-gpuix-quiet.{lane}'
queue = tmp / 'kybern-gpuix-ui-queue'
evidence = Path(os.environ.get('KYBERN_MEMORY_EVIDENCE', '/Users/mymac/projects/ade/previews/gpuix/perf/memory'))
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
    while ((app / 'native/build/memory-final-pending').exists() or lines(order)[:1] != [lane] or list(tmp.glob('kybern-gpuix-quiet.*'))
           or list(tmp.glob('kybern-gpuix-native-build.*')) or list(tmp.glob('kybern-gpuix-build-next.*'))):
        time.sleep(1)
    quiet.write_text(f'{lane} {time.time()} expected duration <25 minutes\n')
    owned = True
    started = time.monotonic()
    scenarios = ['startup-cold', 'startup-warm', 'thread-scroll', 'explorer-scroll',
                 'markdown-scroll', 'code-scroll', 'pr-changes', 'idle-home']
    if '--controls' in sys.argv:
        jobs = [
            ('memory-tooling-typecheck', ['pnpm', 'exec', 'tsc', '-p', 'perf/memory/tsconfig.json'], {}),
            ('memory-startup-disabled', ['bun', 'perf/bench/run.ts', 'startup-cold', 'startup-warm', '--runs', '3', '--label', 'memory-startup-disabled', '--keep-data'],
             {'NAPI_RS_NATIVE_LIBRARY_PATH': str(app / 'native/build/gpuix-native.darwin-arm64.node'), 'KYBERN_IMAGE_MEMORY': '0', 'KYBERN_EDITOR_IMAGE_MEMORY': '0', 'KYBERN_FRAME_MEMORY': '0'}),
            ('memory-startup-enabled', ['bun', 'perf/bench/run.ts', 'startup-cold', 'startup-warm', '--runs', '3', '--label', 'memory-startup-enabled', '--keep-data'],
             {'NAPI_RS_NATIVE_LIBRARY_PATH': str(app / 'native/build/gpuix-native.darwin-arm64.node')}),
            ('memory-startup-baseline', ['bun', 'perf/bench/run.ts', 'startup-cold', 'startup-warm', '--runs', '3', '--label', 'memory-startup-baseline', '--keep-data'],
             {'NAPI_RS_NATIVE_LIBRARY_PATH': str(app / 'native/build/memory-before.node')}),
            *[(label, ['bun', 'perf/bench/run.ts', 'thread-scroll', 'markdown-scroll', '--runs', '3', '--label', label, '--keep-data'],
               {'NAPI_RS_NATIVE_LIBRARY_PATH': str(app / 'native/build' / addon), 'KYBERN_BENCH_RPC_ONLY': '1', 'KYBERN_BENCH_COUNTERS': '1', **flags})
              for label, addon, flags in [
                  ('memory-before-matched', 'memory-before.node', {}),
                  ('memory-after-disabled', 'gpuix-native.darwin-arm64.node', {'KYBERN_IMAGE_MEMORY': '0', 'KYBERN_EDITOR_IMAGE_MEMORY': '0', 'KYBERN_FRAME_MEMORY': '0'}),
                  ('memory-after-matched', 'gpuix-native.darwin-arm64.node', {})]],
        ]
    elif '--memory' in sys.argv:
        jobs = [
            ('before-final-lab', ['bun', 'perf/memory/lab-run.ts', 'before-final-lab'], {}),
            ('after-final-lab', ['bun', 'perf/memory/lab-run.ts', 'after-final-lab'], {}),
            ('before-extra-final', ['bun', 'perf/memory/run.ts', 'before-extra-final'],
             {'KYBERN_MEMORY_GROUPS': 'pull-request,webviews'}),
            ('after-final', ['bun', 'perf/memory/run.ts', 'after-final'], {}),
            ('after-code-repeat', ['bun', 'perf/memory/lab-run.ts', 'after-code-repeat'],
             {'KYBERN_MEMORY_CODE_ONLY': '1', 'KYBERN_MEMORY_CODE_ROUNDS': '2'}),
            ('before-final-visual', ['bun', 'perf/memory/visual.ts', 'before-final'], {}),
            ('after-final-visual', ['bun', 'perf/memory/visual.ts', 'after-final'], {}),
            ('visual-diff', ['bun', 'perf/memory/visual-diff.ts'], {}),
        ]
    else:
        jobs = []
        for label, addon in [('memory-before-final', 'memory-before.node'),
                             ('memory-after-final', 'gpuix-native.darwin-arm64.node')]:
            result_file = app / 'perf/bench/results' / f'{label}.json'
            previous = json.loads(result_file.read_text()) if '--resume' in sys.argv and result_file.exists() else None
            missing = [name for name in scenarios if previous is None or
                       len([row for row in previous['results'] if row['scenario'] == name and row['status'] == 'ok']) != 3]
            if not missing:
                continue
            run_label = f'{label}-retry' if previous else label
            jobs.append((run_label, ['bun', 'perf/bench/run.ts', *missing, '--runs', '3',
                                    '--label', run_label, '--keep-data'],
                         {'NAPI_RS_NATIVE_LIBRARY_PATH': str(app / 'native/build' / addon)}))
    for label, command, extra in jobs:
        env = dict(os.environ, KYBERN_DATA_DIR=str(data), KYBERN_CLIENT_CONFIG_DIR=str(data / 'client'),
                   KYBERN_URL='', KYBERN_TOKEN='', KYBERN_BENCH_PORT='4332',
                   KYBERN_BENCH_EVIDENCE=str(evidence), KYBERN_FULL_RATE='1', **extra)
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
            if '--controls' in sys.argv and label != 'memory-tooling-typecheck':
                file = app / 'perf/bench/results' / f'{label}.json'
                doc = json.loads(file.read_text())
                doc['memoryControlFlags'] = {key: extra.get(key, 'app default') for key in
                                            ['KYBERN_IMAGE_MEMORY', 'KYBERN_EDITOR_IMAGE_MEMORY', 'KYBERN_FRAME_MEMORY']}
                file.write_text(json.dumps(doc, indent=2) + '\n')
            if label in ['memory-before-matched', 'memory-after-matched']:
                canonical = 'memory-before-final' if label == 'memory-before-matched' else 'memory-after-final'
                directory = app / 'perf/bench/results'
                original = directory / f'{canonical}.json'
                matched = json.loads((directory / f'{label}.json').read_text())
                previous = json.loads(original.read_text())
                assert previous['addonSha256'] == matched['addonSha256']
                shutil.copyfile(original, evidence / f'{canonical}-mixed-input.json')
                replaced = {row['scenario'] for row in matched['results']}
                previous['results'] = [row for row in previous['results'] if row['scenario'] not in replaced] + matched['results']
                previous['matchedScrollControl'] = str(directory / f'{label}.json')
                original.write_text(json.dumps(previous, indent=2) + '\n')
            if '--resume' in sys.argv and label.endswith('-retry'):
                canonical = label.removesuffix('-retry')
                directory = app / 'perf/bench/results'
                original = directory / f'{canonical}.json'
                retry = json.loads((directory / f'{label}.json').read_text())
                previous = json.loads(original.read_text())
                assert previous['addonSha256'] == retry['addonSha256']
                assert previous['renderFlags'] == retry['renderFlags']
                assert previous['workload']['counts'] == retry['workload']['counts']
                shutil.copyfile(original, evidence / f'{canonical}-failed-attempt.json')
                replaced = {row['scenario'] for row in retry['results']}
                retry['results'] = [row for row in previous['results'] if row['scenario'] not in replaced and row['status'] == 'ok'] + retry['results']
                retry['recovery'] = {'retainedAcceptedRunsFrom': previous['startedAt'], 'failedAttempt': str(evidence / f'{canonical}-failed-attempt.json')}
                original.write_text(json.dumps(retry, indent=2) + '\n')
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
