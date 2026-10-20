"""Repeat the complete transform check under exclusive UI leases.

Run from apps/gpuix: python3 perf/combine/repeat.py --repeats 10
CPU workers run only inside the acquired lease and are always reaped. This is a
correctness stress test; its incidental cadence numbers are not performance data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

APP = Path(__file__).resolve().parents[2]
ROOT = APP.parents[1]
EVIDENCE = Path('/Users/mymac/projects/ade/previews/gpuix/perf/combine')
SCRATCH = Path('/Users/mymac/projects/ade-gpuix-scratch/perf-combine')


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def check(workers):
    # Inherit the lease's process group so interruption also catches descendants.
    loads = []
    command = 'import hashlib; data=b"gpuix correctness stress"*4096\nwhile True: hashlib.sha256(data).digest()'
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        for _ in range(workers):
            loads.append(subprocess.Popen([sys.executable, '-c', command]))
        return subprocess.call(['nice', '-n', '15', 'bun', 'native/subtree-transform-check.ts'], cwd=APP)
    finally:
        for child in loads:
            child.terminate()
        for child in loads:
            child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repeats', type=int, default=10)
    parser.add_argument('--cpu-workers', type=int, default=4)
    parser.add_argument('--child', type=int)
    args = parser.parse_args()
    if args.child is not None:
        return check(args.child)
    if args.repeats < 1 or args.cpu_workers < 1:
        parser.error('repeats and CPU workers must be positive')
    addons = {
        'combined': APP / 'native/build/gpuix-native.darwin-arm64.node',
        'scroll2': ROOT.parent / 'ade-gpuix-perf-scroll2/apps/gpuix/native/build/gpuix-native.darwin-arm64.node',
        'markdown': ROOT.parent / 'ade-gpuix-perf-markdown/apps/gpuix/native/build/gpuix-native.darwin-arm64.node',
    }
    metadata = {
        'kind': 'correctness stress, not timing/resource acceptance',
        'repeats': args.repeats, 'cpuWorkers': args.cpu_workers,
        'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'addons': {name: {'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()} for name, file in addons.items()},
        'cases': [], 'startedAt': time.time(),
    }
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result_file = EVIDENCE / 'repeat-results.json'
    for repeat in range(1, args.repeats + 1):
        for load in ['idle', 'cpu']:
            for region in ['0', '1']:
                for name, addon in addons.items():
                    label = f'{name}-{load}-region{region}-{repeat:02}'
                    out = EVIDENCE / 'repeats' / label
                    out.mkdir(parents=True, exist_ok=True)
                    env = dict(os.environ, KYBERN_DATA_DIR=str(SCRATCH / 'stress-data'),
                        KYBERN_CLIENT_CONFIG_DIR=str(SCRATCH / 'stress-config'), KYBERN_URL='', KYBERN_TOKEN='',
                        NAPI_RS_NATIVE_LIBRARY_PATH=str(addon), KYBERN_VERIFY_OUTPUT=str(out),
                        KYBERN_REGION_PAINT=region, KYBERN_FULL_RATE='1')
                    start = time.time()
                    with (out / 'check.log').open('w') as log:
                        code = subprocess.call(['bun', 'native/ui-lease.ts', 'combine-' + label,
                            sys.executable, str(Path(__file__).resolve()), '--child', str(args.cpu_workers if load == 'cpu' else 0)],
                            cwd=APP, env=env, stdout=log, stderr=subprocess.STDOUT)
                    modes = sorted(file.stem for file in out.glob('*.json'))
                    case = {'label': label, 'addon': name, 'load': load, 'region': region,
                        'repeat': repeat, 'code': code, 'modes': modes, 'seconds': time.time() - start}
                    metadata['cases'].append(case)
                    result_file.write_text(json.dumps(metadata, indent=2))
                    print(json.dumps(case), flush=True)
                    if code or len(modes) != 4:
                        return 1
    metadata['finishedAt'] = time.time()
    result_file.write_text(json.dumps(metadata, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
