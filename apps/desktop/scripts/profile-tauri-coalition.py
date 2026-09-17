#!/usr/bin/env python3
"""Sample a launched macOS Tauri app and its attributed WebKit processes.

Usage: profile-tauri-coalition.py SHELL_EXECUTABLE PHASE_FILE OUTPUT_JSONL
The phase file contains a short workload label; write 'stop' to finish.
No launch, termination, credentials, forced collection or production data access.
Resource coalition ABI: apple-oss-distributions/xnu bsd/sys/proc_info_private.h
and osfmk/mach/coalition.h (PROC_PIDCOALITIONINFO=20, two coalition types).
Only the supplied executable, its sibling kybernd, and WebKit services in the
shell's resource coalition qualify. Every sample rediscovers processes and
records kernel process-start identity; an app restart acquires its new coalition.
Combined footprint is the sum of per-process physical footprints, not unique
physical RAM. RSS is also recorded and may double-count shared mappings.
"""
import ctypes
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('memory', Path(__file__).with_name('profile-memory.py'))
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)
sampler = memory.Sampler()
if sampler.system != 'Darwin':
    raise SystemExit('This process-attribution method requires macOS.')
lib = sampler.lib
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int


def coalition(pid):
    value = (ctypes.c_uint64 * 5)()
    if lib.proc_pidinfo(pid, 20, 0, value, ctypes.sizeof(value)) != ctypes.sizeof(value):
        return None
    return value[0] or None


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('shell_executable', type=Path)
parser.add_argument('phase_file', type=Path)
parser.add_argument('output_jsonl', type=Path)
args = parser.parse_args()
shell = str(args.shell_executable.resolve(strict=True))
daemon = str(Path(shell).with_name('kybernd'))
phase_file = args.phase_file
start = time.monotonic()
with args.output_jsonl.open('x') as output:
    while time.monotonic() - start < 1800:
        phase = phase_file.read_text().strip()
        if phase == 'stop':
            break
        processes = []
        for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines():
            pid, executable = line.strip().split(None, 1)
            processes.append((int(pid), executable))
        shells = [pid for pid, executable in processes if executable == shell]
        coalitions = {coalition(pid) for pid in shells} - {None}
        records = []
        for pid, executable in processes:
            role = ('shell' if executable == shell else 'daemon' if executable == daemon else
                    'frontend' if '/com.apple.WebKit.WebContent.xpc/' in executable else
                    'webkit_auxiliary' if '/com.apple.WebKit.' in executable else None)
            if role is None:
                continue
            owner = coalition(pid)
            if owner not in coalitions:
                continue
            try:
                sample = sampler.sample(pid)
                # Recheck ownership and identity around discovery; a PID can be
                # recycled between ps, proc_pidinfo and proc_pid_rusage.
                if coalition(pid) != owner or sampler.sample(pid)['identity'] != sample['identity']:
                    continue
                records.append(dict(pid=pid, role=role, service=Path(executable).name, coalition=owner, **sample))
            except OSError as error:
                records.append(dict(pid=pid, role=role, error=str(error)))
        complete = (not any('error' in r for r in records)
                    and {'shell', 'daemon', 'frontend', 'webkit_auxiliary'} <= {r['role'] for r in records}
                    and {'com.apple.WebKit.GPU', 'com.apple.WebKit.Networking'} <= {r.get('service') for r in records})
        record = dict(elapsed=time.monotonic() - start, phase=phase, complete=complete,
                      processes=records, combined=memory.totals(records) if complete else None)
        output.write(json.dumps(record) + '\n')
        output.flush()
        time.sleep(.5)
