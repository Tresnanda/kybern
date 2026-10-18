"""Normalize final evidence without mixing exploratory or contaminated runs."""
import json, pathlib, re
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/transcript')
rows=[]
for label,count in [('baseline-final-fixed',1000),('final-fixed',1000),('baseline-final-fixed',3000),('final-fixed',3000),('baseline-final-fixed-stream',1000),('final-fixed-stream',1000)]:
 for raw in json.loads((out/f'{label}-{count}-dark.json').read_text()):
  resource=re.search(r'total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms',raw['resource'])
  if not resource:raise ValueError(f'Missing resource sample: {label} {count}')
  row={**raw,'variant':'before' if label.startswith('baseline') else 'after','stream':label.endswith('stream'),'footprintMiB':float(resource[1]),'cpuPercent':float(resource[2]),'gpuMs':float(resource[3])}
  rows.append(row)
(out/'comparison-final.json').write_text(json.dumps(rows,indent=2))
def n(value):return '—' if value is None else f'{value:.2f}'
print('| Turns / scene | Variant | Frames | p50 / p95 / p99 ms | >16.7 / >33 | Dispatch→paint p95 ms | CPU % | GPU ms / 15s | MiB |')
print('|---|---|---:|---|---|---:|---:|---:|---:|')
for r in rows:
 scene='stream' if r['stream'] else r['scenario']
 print(f"| {r['count']} / {scene} | {r['variant']} | {r['frames']} | {n(r['p50'])} / {n(r['p95'])} / {n(r['p99'])} | {r['over16_7']} / {r['over33']} | {n(r['nativeFirstInputToCpuPaintP95'])} | {r['cpuPercent']:.2f} | {r['gpuMs']:.1f} | {r['footprintMiB']:.0f} |")
print('\n| Turns / scene | Variant | First formatted content ms | Native render / layout p95 ms | React p95 ms | Commits |')
print('|---|---|---:|---|---:|---:|')
for r in rows:
 if r['scenario']=='idle':continue
 scene='stream' if r['stream'] else r['scenario']
 print(f"| {r['count']} / {scene} | {r['variant']} | {r['firstVisibleMs']:.0f} | {n(r['renderP95'])} / {n(r['layoutP95'])} | {n(r['reactRenderP95'])} | {r['reactCommits']} |")
