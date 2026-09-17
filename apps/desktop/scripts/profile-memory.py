#!/usr/bin/env python3
"""Read-only, explicitly attributed process-memory sampler for native Kybern.

No process discovery, launch/kill, privilege escalation, heap forcing, or app hooks.
The operator supplies verified PID ownership and updates the phase/PIDs JSON file
atomically as workflows run. Logs no process arguments, tokens, or application data.
"""
from __future__ import annotations
import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import platform
import statistics
import sys
import time

ROLES = ('frontend', 'daemon', 'shell', 'webkit_auxiliary')
METRICS = ('rss_bytes', 'physical_footprint_bytes', 'pss_bytes', 'uss_bytes')


class RusageInfoV0(ctypes.Structure):
    # ABI: apple-oss-distributions/xnu, bsd/sys/resource.h, rusage_info_v0.
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups', 'ri_interrupt_wkups',
        'ri_pageins', 'ri_wired_size', 'ri_resident_size', 'ri_phys_footprint',
        'ri_proc_start_abstime', 'ri_proc_exit_abstime')]


class Sampler:
    def __init__(self) -> None:
        self.system = platform.system()
        self.lib = None
        if self.system == 'Darwin':
            self.lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
            self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
            self.lib.proc_pid_rusage.restype = ctypes.c_int
        elif self.system != 'Linux':
            raise ValueError('This sampler supports macOS and Linux only.')

    def sample(self, pid: int) -> dict:
        if type(pid) is not int or pid <= 0:
            raise ValueError('PID must be a positive integer.')
        if self.system == 'Darwin':
            usage = RusageInfoV0()
            if self.lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
                errno = ctypes.get_errno()
                raise OSError(errno, os.strerror(errno))
            if usage.ri_proc_exit_abstime:
                raise ProcessLookupError('Process has exited.')
            return {'identity': str(usage.ri_proc_start_abstime),
                    'rss_bytes': usage.ri_resident_size,
                    'physical_footprint_bytes': usage.ri_phys_footprint,
                    'pss_bytes': None, 'uss_bytes': None}
        root = Path('/proc') / str(pid)
        def identity() -> str:
            # Field 22; command names may contain spaces and parentheses.
            return (root / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        before = identity()
        data = {}
        for line in (root / 'smaps_rollup').read_text().splitlines():
            bits = line.split()
            if len(bits) == 3 and bits[2] == 'kB':
                data[bits[0].rstrip(':')] = int(bits[1]) * 1024
        if identity() != before:
            raise ProcessLookupError('PID was reused during sampling.')
        return {'identity': before, 'rss_bytes': data['Rss'],
                'physical_footprint_bytes': None, 'pss_bytes': data['Pss'],
                'uss_bytes': data.get('Private_Clean', 0) + data.get('Private_Dirty', 0) + data.get('Private_Hugetlb', 0)}


def validate_manifest(value: dict) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get('phase'), str) or not value['phase'].strip():
        raise ValueError('A nonempty phase is required.')
    if value.get('scope', 'partial') not in ('partial', 'whole_app'):
        raise ValueError('Scope must be partial or whole_app.')
    if not isinstance(value.get('coverage_note'), str) or not value['coverage_note'].strip():
        raise ValueError('Describe how PID ownership and WebKit helper coverage were verified.')
    processes = value.get('processes')
    if not isinstance(processes, list) or not processes:
        raise ValueError('Provide at least one explicitly attributed process.')
    seen = set()
    for item in processes:
        if not isinstance(item, dict) or item.get('role') not in ROLES:
            raise ValueError('Each process needs a recognized role.')
        pid = item.get('pid')
        if type(pid) is not int or pid <= 0 or pid in seen:
            raise ValueError('PIDs must be positive and cannot occur twice across roles.')
        seen.add(pid)
    roles = {item['role'] for item in processes}
    if value.get('scope') == 'whole_app':
        if not {'frontend', 'daemon', 'shell'}.issubset(roles) or value.get('webkit_helpers_verified') is not True:
            raise ValueError('Whole-app scope requires frontend, daemon, shell, and explicit WebKit-helper verification.')
    return value


def read_manifest(path: Path) -> dict:
    return validate_manifest(json.loads(path.read_text()))


def totals(processes: list[dict]) -> dict:
    if not processes or any('error' in item for item in processes):
        return {key: None for key in METRICS}
    return {key: sum(item[key] for item in processes) if all(item.get(key) is not None for item in processes) else None for key in METRICS}


def record(args: argparse.Namespace) -> None:
    if not math.isfinite(args.interval) or args.interval < 0.05:
        raise ValueError('Use a finite interval of at least 0.05 seconds.')
    if not math.isfinite(args.duration) or args.duration <= 0:
        raise ValueError('Duration must be positive and finite.')
    manifest = read_manifest(args.pids)
    sampler = Sampler()
    identities = {}
    known = set()
    out = args.output.open('x')  # Never overwrite an earlier measurement.
    with out:
        out.write(json.dumps({'type': 'metadata', 'version': 1, 'label': args.label,
            'commit': args.commit, 'workload_id': args.workload_id,
            'system': platform.system(), 'release': platform.release(), 'machine': platform.machine(),
            'interval_seconds': args.interval, 'duration_seconds': args.duration,
            'coverage_note': manifest['coverage_note'], 'scope': manifest.get('scope', 'partial'), 'started_unix': time.time(),
            'measurement_notes': 'Explicit PID attribution; totals are simultaneous sample sums, not unique-system memory. RSS can double-count shared pages. Peaks are sampled, not guaranteed lifetime maxima.'}) + '\n')
        started = time.monotonic()
        deadline = started + args.duration
        next_sample = started
        while time.monotonic() < deadline:
            tick = time.monotonic()
            try:
                current = read_manifest(args.pids)
                if current.get('scope', 'partial') != manifest.get('scope', 'partial'):
                    raise ValueError('Measurement scope changed; start a new run.')
                manifest = current
                readings = []
                for item in manifest['processes']:
                    reading = dict(item)
                    try:
                        reading.update(sampler.sample(item['pid']))
                        key = item['pid']
                        if key in identities and identities[key] != reading['identity']:
                            raise ProcessLookupError('PID identity changed; start a new run instead of silently attributing the replacement.')
                        identities[key] = reading['identity']
                        known.add((item['role'], item['pid'], reading['identity']))
                    except (OSError, KeyError, ValueError) as error:
                        reading = {**item, 'error': str(error)}
                    readings.append(reading)
                groups = {role: totals([x for x in readings if x['role'] == role]) for role in ROLES}
                groups['attributed_total'] = totals(readings)
                row = {'type': 'sample', 'elapsed_seconds': tick - started,
                    'phase': manifest['phase'], 'coverage_note': manifest['coverage_note'],
                    'sample_duration_seconds': time.monotonic() - tick,
                    'processes': readings, 'groups': groups}
            except (OSError, ValueError, KeyError) as error:
                row = {'type': 'sample_error', 'elapsed_seconds': tick - started, 'error': str(error)}
            out.write(json.dumps(row) + '\n')
            out.flush()
            next_sample += args.interval
            # A delayed sampler never pretends that multiple catch-up samples occurred.
            if next_sample < time.monotonic():
                next_sample = time.monotonic()
            time.sleep(min(max(0.0, next_sample - time.monotonic()), max(0.0, deadline - time.monotonic())))
        out.write(json.dumps({'type': 'end', 'observed_identities': sorted(known), 'elapsed_seconds': time.monotonic() - started}) + '\n')


def summarize(path: Path) -> dict:
    series = {}
    errors = 0
    metadata = None
    max_skew = 0.0
    ended = False
    sample_count = 0
    for line in path.read_text().splitlines():
        row = json.loads(line)
        if ended:
            raise ValueError('Unexpected records after measurement completion.')
        if row['type'] == 'metadata':
            if metadata is not None:
                raise ValueError('Duplicate measurement metadata.')
            metadata = row
        elif row['type'] == 'sample_error':
            errors += 1
        elif row['type'] == 'end':
            if metadata is None or row['elapsed_seconds'] < metadata['duration_seconds']:
                raise ValueError('Measurement ended before its configured duration.')
            ended = True
        elif row['type'] == 'sample':
            sample_count += 1
            max_skew = max(max_skew, row['sample_duration_seconds'])
            errors += sum('error' in p for p in row['processes'])
            for group, measures in row['groups'].items():
                for metric, value in measures.items():
                    if value is not None:
                        series.setdefault((row['phase'], group, metric), []).append(value)
    if metadata is None:
        raise ValueError('Missing measurement metadata.')
    if not ended or sample_count == 0:
        raise ValueError('Incomplete measurement: require samples and a completion record.')
    return {'metadata': metadata, 'sample_errors': errors, 'max_sample_skew_seconds': max_skew,
        'results': [{'phase': phase, 'group': group, 'metric': metric, 'samples': len(values),
            'median_bytes': statistics.median(values), 'sampled_peak_bytes': max(values), 'min_bytes': min(values)}
            for (phase, group, metric), values in sorted(series.items())]}


def compare(before: dict, after: dict) -> dict:
    for key in ('workload_id', 'system', 'release', 'machine', 'interval_seconds', 'duration_seconds', 'scope'):
        if before['metadata'][key] != after['metadata'][key]:
            raise ValueError(f'Measurement method/environment mismatch: {key}')
    if before['sample_errors'] or after['sample_errors']:
        raise ValueError('Cannot claim a comparison from logs with sampling errors.')
    def index(report):
        return {(x['phase'], x['group'], x['metric']): x for x in report['results']}
    a, b = index(before), index(after)
    if set(a) != set(b):
        raise ValueError('Phase/group/metric coverage differs; do not silently omit missing measurements.')
    output = []
    for key in sorted(a):
        for measure in ('median_bytes', 'sampled_peak_bytes'):
            x, y = a[key][measure], b[key][measure]
            output.append({'phase': key[0], 'group': key[1], 'metric': key[2], 'measure': measure,
                          'before': x, 'after': y, 'reduction_bytes': x-y,
                          'reduction_percent': (100 * (x-y) / x) if x else None,
                          'before_samples': a[key]['samples'], 'after_samples': b[key]['samples']})
    return {'comparison': output, 'notes': 'Operator must still verify identical data, phase actions/timing, window/display, power and visual settings, warm/cold state, native WebKit ownership, and repeated runs. Summed RSS is not unique memory. This is not an automatic performance acceptance decision.'}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    s = p.add_subparsers(dest='command', required=True)
    r = s.add_parser('record')
    r.add_argument('--pids', type=Path, required=True)
    r.add_argument('--output', type=Path, required=True)
    r.add_argument('--label', required=True)
    r.add_argument('--commit', required=True)
    r.add_argument('--workload-id', required=True)
    r.add_argument('--interval', type=float, default=0.25)
    r.add_argument('--duration', type=float, default=300)
    q = s.add_parser('summarize'); q.add_argument('log', type=Path)
    c = s.add_parser('compare'); c.add_argument('before', type=Path); c.add_argument('after', type=Path)
    args = p.parse_args()
    if args.command == 'record': record(args)
    elif args.command == 'summarize': print(json.dumps(summarize(args.log), indent=2))
    else: print(json.dumps(compare(summarize(args.before), summarize(args.after)), indent=2))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        raise SystemExit(1)
