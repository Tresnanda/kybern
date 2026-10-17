#!/usr/bin/env python3
"""Longest run of `[kybern-frame] <ms>` lines with gaps under 30 ms (an animation playing) in a captured stderr log: n, p50, p95, max."""
import re, sys
t = [float(m.group(1)) for m in re.finditer(r'\[kybern-frame\] ([0-9.]+)', open(sys.argv[1]).read())]
t = [x for x in t if x > 0]
runs, cur = [], [t[0]] if t else []
for a, b in zip(t, t[1:]):
    if b - a < 30: cur.append(b)
    else: runs.append(cur); cur = [b]
runs.append(cur)
best = max(runs, key=len)
dt = sorted(b - a for a, b in zip(best, best[1:]))
if dt: print(f'run of {len(best)} frames over {best[-1]-best[0]:.0f} ms: p50={dt[len(dt)//2]:.1f} p95={dt[int(len(dt)*0.95)]:.1f} max={dt[-1]:.1f} ms')
