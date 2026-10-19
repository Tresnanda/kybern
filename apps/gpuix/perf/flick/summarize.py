"""Keep per-run distributions and small median aggregates, without pooling runs."""
import json,statistics,sys
from pathlib import Path
prefix=sys.argv[1] if len(sys.argv)>1 else 'final-frame'
candidate=sys.argv[2] if len(sys.argv)>2 else 'default'
root=Path('/Users/mymac/projects/ade/previews/gpuix/perf/flick')
rows=[];provenance={}
def med(values):
 values=[v for v in values if v is not None]
 return statistics.median(values) if values else None
for variant in ['0',candidate]:
 d=json.loads((root/f'{prefix}-{variant}.json').read_text());assert not d['aborted']
 provenance[variant]={k:d[k] for k in ['source','addonSha256','hardware','host','display','inputContinuity','fullRate','renderFlags','warmupSeconds','resourceSeconds','workload']}
 for name in dict.fromkeys(r['scenario'] for r in d['results']):
  runs=[r for r in d['results'] if r['scenario']==name and r['status']=='ok'];assert len(runs)==3,(name,variant,len(runs))
  assert all(not r['evidence'].get('overlap') and not r['evidence'].get('orphanOverlap') and not r['evidence'].get('screenInvalid') for r in runs)
  for r in runs:
   for endpoint in ['windowBefore','windowAfter']:
    assert any(w.get('onscreen') and w.get('scale')==2 and -1440<=w['x']<0 and w['y']>=900 and w['x']+w['width']<=0 and w['y']+w['height']<=1800 for w in r['evidence'][endpoint]), (name,variant,endpoint)
   assert not r['evidence'].get('profiled')
   if name.endswith('scroll') or name=='thread-fling':assert r['evidence']['appkitAccepted'] and r['evidence']['continuityBridgeMs']==5000
   if name=='thread-fling':assert r['evidence']['loadedHistoryTurns']==3000
  row={'scenario':name,'variant':variant,'runs':len(runs),'frames':{key:med([r['frames'][key] for r in runs]) for key in ['p50','p95','p99','count','over16_7']},'worstGapMs':max([r['frames']['max'] or 0 for r in runs]),'over33ByRun':[r['frames']['over33'] for r in runs],'proxyP95':med([r['latency']['proxyMs']['p95'] for r in runs]),'nativeDispatchPaintFirstP95':med([r['evidence'].get('nativeDispatchToCpuPaint',{}).get('firstMs',{}).get('p95') for r in runs]),'cpuPercent':med([r['resources']['cpuPercent'] for r in runs]),'gpuMs':med([r['resources']['gpuMs'] for r in runs]),'footprintMiB':med([r['resources']['footprintMiB'] for r in runs]),'renderP95':med([r['work']['renderMs']['p95'] for r in runs]),'layoutP95':med([r['work']['layoutMs']['p95'] for r in runs]),'cpuMsPerSubmission':med([r['evidence'].get('averageProcessCpuMsPerSubmission') for r in runs]),'gpuMsPerSubmission':med([r['evidence'].get('averageProcessGpuMsPerSubmission') for r in runs]),'historyVisibleMs':med([r['timings'].get('olderHistoryVisibleMs') for r in runs]),'input':[{k:r['evidence'].get(k) for k in ['input','appkitAccepted','offeredPackets','handledPackets','requestedDistance','effectiveDistance','handlerDistance','inputProductionMs','loadedHistoryTurns']} for r in runs]}
  rows.append(row)
assert provenance['0']['addonSha256']==provenance[candidate]['addonSha256']
small={'meaning':'Medians of three independent windows; max is worst, counts over33 retain each run. Native submissions, not physical presents. GPU is per-process AGX accumulated milliseconds/window. Profiles excluded.','provenance':provenance,'results':rows}
Path('perf/flick/RESULTS.json').write_text(json.dumps(small,indent=2)+'\n')
header='| Scenario | Variant | p50 / p95 / p99 ms | Worst max ms | >16.7 median | >33 by run | Proxy p95 | CPU % | GPU ms / window | MiB |'
lines=[header,'|'+'---|'*10]
def f(v):return '—' if v is None else f'{v:.2f}'
for r in rows:
 lines.append('| '+' | '.join([r['scenario'],r['variant'],' / '.join(f(r['frames'][k]) for k in ['p50','p95','p99']),f(r['worstGapMs']),f(r['frames']['over16_7']),'/'.join(map(str,r['over33ByRun'])),f(r['proxyP95']),f(r['cpuPercent']),f(r['gpuMs']),f(r['footprintMiB'])])+' |')
(root/f'{prefix}-table.md').write_text('\n'.join(lines)+'\n');print('\n'.join(lines))
