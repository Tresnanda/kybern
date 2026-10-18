"""Summarize retained raw measurements without mixing diagnostic profiles."""
import json,pathlib,re,statistics
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2')
rows=[]
def resource(text):
 m=re.search(r'total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms over ([\d.]+)s',text)
 return dict(zip(('footprintMiB','cpuPercent','gpuMs','sampleSeconds'),map(float,m.groups()))) if m else {}
for variant in ('dense','sparse'):
 for count,suffix in ((3000,''),(30000,'-synthetic')):
  p=out/'transcript'/f'{variant}{suffix}-{count}-dark.json'
  if not p.exists():continue
  for v in json.loads(p.read_text()):
   rows.append(dict(variant=variant,scenario=f'{count} {v["scenario"]}',frames=v['frames'],p50=v['p50'],p95=v['p95'],p99=v['p99'],over16_7=v['over16_7'],over33=v['over33'],renderP95=v['renderP95'],layoutP95=v['layoutP95'],inputPaintP95=v['nativeFirstInputToCpuPaintP95'],firstVisibleMs=v['firstVisibleMs'],**resource(v['resource'])))
 for label in ('settled','fast'):
  p=out/'sidebar'/f'{variant}-{label}-dark.json'
  if not p.exists():continue
  for v in json.loads(p.read_text())['results']:
   rows.append(dict(variant=variant,scenario=f'300 sidebar {label}',frames=v['frames'],p50=v['p50'],p95=v['p95'],p99=v['p99'],over16_7=v['over16_7'],over33=v['over33'],renderP95=v['renderP95'],layoutP95=v['layoutP95'],inputPaintP95=v['inputToCpuPaintP95'],**resource(v['resourceText'])))
 p=out/f'bench-{variant}.json'
 if p.exists():
  groups={}
  for v in json.loads(p.read_text())['results']:
   if v['status']=='ok':groups.setdefault(v['scenario'],[]).append(v)
  med=lambda vs:statistics.median([x for x in vs if x is not None]) if any(x is not None for x in vs) else None
  for scenario,vs in groups.items():
   row=dict(variant=variant,scenario='bench '+scenario,runs=len(vs))
   for key in ('p50','p95','p99','over16_7','over33'):row[key]=med([v['frames'][key] for v in vs])
   for key in ('cpuPercent','gpuMs','footprintMiB'):row[key]=med([v['resources'][key] for v in vs])
   row['inputPaintP95']=med([v['latency']['proxyMs']['p95'] for v in vs]);row['timings']=[v.get('timings') for v in vs]
   rows.append(row)
(out/'summary.json').write_text(json.dumps(rows,indent=2))
cols=['scenario','variant','p50','p95','p99','over16_7','over33','renderP95','layoutP95','inputPaintP95','cpuPercent','gpuMs','footprintMiB']
fmt=lambda x:'—' if x is None else f'{x:.2f}' if isinstance(x,float) else str(x)
table='| '+' | '.join(cols)+' |\n| '+' | '.join(['---']*len(cols))+' |\n'+'\n'.join('| '+' | '.join(fmt(v.get(c)) for c in cols)+' |' for v in rows)+'\n'
(out/'summary.md').write_text(table);print(table)
