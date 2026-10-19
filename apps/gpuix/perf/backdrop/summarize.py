from pathlib import Path
import json,re,statistics
root=Path(__file__).resolve().parents[4]
app=root/'apps/gpuix'
out=Path('/Users/mymac/projects/ade/previews/gpuix/perf/backdrop')
labels=['backdrop-before','backdrop-control','backdrop-after','backdrop-diagnostic-before','backdrop-diagnostic-control','backdrop-diagnostic-after','backdrop-stream-reverse-after','backdrop-stream-reverse-control','backdrop-idle-before','backdrop-idle-control','backdrop-idle-after','backdrop-original-reverse-after','backdrop-original-reverse-before']
summary={}
median=lambda xs:statistics.median([x for x in xs if x is not None]) if any(x is not None for x in xs) else None
for label in labels:
 p=out/(label+'.json')
 if not p.exists():continue
 d=json.loads(p.read_text());groups={}
 for r in d['results']:
  if r['status']=='ok':groups.setdefault(r['scenario'],[]).append(r)
 summary[label]={'meta':{k:v for k,v in d.items() if k!='results'},'scenarios':{}}
 for name,rows in groups.items():
  fields={f'ms{q}':median([r['frames'][q] for r in rows]) for q in ['p50','p95','p99']}
  fields.update({k:median([r['frames'][k] for r in rows]) for k in ['count','over16_7','over33']})
  fields.update({k:median([r['resources'][k] for r in rows]) for k in ['cpuPercent','gpuMs','footprintMiB']})
  fields.update({'proxyP95':median([r['latency']['proxyMs']['p95'] for r in rows]),'gpuMsPerSubmission':median([r['evidence'].get('averageProcessGpuMsPerSubmission') for r in rows]),'cpuMsPerSubmission':median([r['evidence'].get('averageProcessCpuMsPerSubmission') for r in rows])})
  if name.startswith('idle-'):
   fields['gpuMsPerSubmission']=None;fields['cpuMsPerSubmission']=None
  summary[label]['scenarios'][name]=fields
  if 'diagnostic' in label:
   logs=list((out/label).glob(f'{name}-attempt-*/*.log'))
   if not logs:continue
   raw=max(logs,key=lambda p:p.stat().st_mtime).read_text()
   kernel=[(float(s),int(t)) for s,t in re.findall(r'\[backdrop-kernel\] sigma=([0-9.]+) taps=(\d+)',raw)]
   elapsed=[float(x) for x in re.findall(r'\[paint-gpu\] stage=frame ms=([0-9.]+)',raw)][-rows[-1]['frames']['count']:]
   scenes=[dict((k,float(v)) for k,v in re.findall(r'(\w+)=([0-9.]+)',line)) for line in raw.splitlines() if line.startswith('[gpu-scene]')][-rows[-1]['frames']['count']:]
   fields['diagnostic']={'kernelTapsMedian':median([t for _,t in kernel]),'kernelTapsMin':min([t for _,t in kernel],default=None),'kernelTapsMax':max([t for _,t in kernel],default=None),'kernelRecords':len(kernel),'commandElapsedMedian':median(elapsed),'sceneMedian':{k:median([s.get(k) for s in scenes]) for k in ['draws','backdropDraws','backdrops','batches','quads','glyphs','colorSprites','shadows','paths','pathVertices','rasterArea','instanceBytes','roundedNodes','glyphClipSteps','glyphClipDepthMax','roundedGlyphs','prunedGlyphs','atlasUploads','atlasBytes','atlasEvictions']}}
(out/'summary.json').write_text(json.dumps(summary,indent=2))
(app/'perf/backdrop/results.json').write_text(json.dumps(summary,indent=2))
fmt=lambda x:'—' if x is None else f'{x:.2f}'
lines=[]
for label,d in summary.items():
 seconds=d['meta']['resourceSeconds']
 lines+=['## '+label,'','| Scenario | p50/p95/p99 ms | >16.7/>33 | Proxy p95 | CPU % | GPU ms/'+str(seconds)+'s | GPU ms/submission | CPU ms/submission | MiB |','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
 for name,f in d['scenarios'].items():
  lines.append('| '+name+' | '+ '/'.join(fmt(f['ms'+q]) for q in ['p50','p95','p99'])+' | '+ '/'.join(fmt(f[k]) for k in ['over16_7','over33'])+' | '+ ' | '.join(fmt(f[k]) for k in ['proxyP95','cpuPercent','gpuMs','gpuMsPerSubmission','cpuMsPerSubmission','footprintMiB'])+' |')
 lines+=['']
(out/'tables.md').write_text('\n'.join(lines))
print('\n'.join(lines))
