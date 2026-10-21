"""Median table of the retained-memory runs: python3 perf/ramfix/summarize.py label[,label...] ..."""
import json, statistics, sys
from pathlib import Path

root = Path('/Users/mymac/projects/ade/previews/motion/ramfix')
cats = ['App-Specific Tag 1', 'IOAccelerator', 'IOAccelerator (graphics)', 'Untagged', 'Malloc Small', 'JS JIT Generated Code']
med = lambda xs: round(statistics.median(xs), 1) if xs else None

print('| Runs | Home | After workload | After release | After 2 min idle | Peak | Reopen thread / code / note ms |')
print('|---|---:|---:|---:|---:|---:|---|')
for group in sys.argv[1:]:
    docs = [json.loads((root / f'retained-{label}' / 'results.json').read_text()) for label in group.split(',')]
    def sample(name, key='footprintMB'):
        return med([row[key] for d in docs for row in d['rows'] if row['name'] == name])
    reopen = [d.get('reopen') or {} for d in docs]
    r = lambda k: med([x[k] for x in reopen if k in x])
    print(f"| {group} | {sample('home-initial')} | {sample('after-workload')} | {sample('after-release') or '—'} | {sample('after-idle')} | {sample('after-idle', 'peakMB')} | {round(r('longThreadMs'))} / {round(r('codeFileMs'))} / {round(r('imageNoteMs'))} |")

print()
print('| Runs | Sample | ' + ' | '.join(cats) + ' |')
print('|---|---|' + '---:|' * len(cats))
for group in sys.argv[1:]:
    docs = [json.loads((root / f'retained-{label}' / 'results.json').read_text()) for label in group.split(',')]
    for name in ['home-initial', 'after-workload', 'after-release', 'after-idle']:
        rows = [row for d in docs for row in d['rows'] if row['name'] == name]
        if rows:
            print(f'| {group} | {name} | ' + ' | '.join(str(med([row['categoriesMB'][c] for row in rows])) for c in cats) + ' |')
