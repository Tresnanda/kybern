from pathlib import Path
import json,re,statistics,shutil
app=Path(__file__).resolve().parents[2]
evidence=Path('/Users/mymac/projects/ade/previews/gpuix/perf/gpu')
labels=['gpu-before','gpu-control','gpu-after','gpu-diagnostic-control','gpu-diagnostic-after','gpu-stream-reverse-1','gpu-stream-reverse-0']
all_rows={}
for label in labels:
    p=app/'perf/bench/results'/f'{label}.json'
    if not p.exists():continue
    d=json.loads(p.read_text())
    shutil.copy2(p,evidence/f'{label}.json')
    rows=[r for r in d['results'] if r['status']=='ok']
    all_rows[label]={'addonSha256':d['addonSha256'],'fullRate':d['fullRate'],'host':d['host'],'hardware':d['hardware'],'renderFlags':d['renderFlags'],'gpuLaneControls':d.get('gpuLaneControls'),'resourceSeconds':d['resourceSeconds'],'warmupSeconds':d['warmupSeconds'],'aborted':d['aborted'],'results':[{k:r[k] for k in ['scenario','run','frames','resources','work','latency']}|{'gpuMsPerSubmission':r['evidence'].get('averageProcessGpuMsPerSubmission'),'cpuMsPerSubmission':r['evidence'].get('averageProcessCpuMsPerSubmission'),'input':r['evidence'].get('input'),'packets':r['evidence'].get('offeredPackets'),'packetsPerSecond':r['evidence'].get('offeredPacketsPerSecond'),'deltasPerSecond':r['evidence'].get('offeredDeltasPerSecond'),'nativeMemory':r['evidence'].get('counters',{}).get('nativeMemory'),'screenStateBefore':r['evidence'].get('screenStateBefore'),'screenStateAfter':r['evidence'].get('screenStateAfter')} for r in rows]}

def median(items):
    xs=[x for x in items if x is not None]
    return statistics.median(xs) if xs else None

def parse_scene(line):
    row={k:float(v) for k,v in re.findall(r'(\w+)=([0-9.]+)',line)}
    viewport=re.search(r'viewport=(\d+)x(\d+)',line)
    if viewport:
        row.pop('viewport',None)
        row.update(viewportWidth=float(viewport[1]),viewportHeight=float(viewport[2]))
    return row

diags={}
for label in labels:
    if 'diagnostic' not in label or label not in all_rows:continue
    diags[label]={}
    for row in all_rows[label]['results']:
        name=row['scenario'];logs=list((evidence/label).glob(f'{name}-attempt-*/*.log'))
        if not logs:continue
        raw=max(logs,key=lambda p:p.stat().st_mtime).read_text()
        scene=[parse_scene(line) for line in raw.splitlines() if line.startswith('[gpu-scene]')][-row['frames']['count']:]
        gpu=[float(x) for x in re.findall(r'\[paint-gpu\] stage=frame ms=([0-9.]+)',raw)][-row['frames']['count']:]
        fields={k:median([r.get(k) for r in scene]) for k in scene[0]} if scene else {}
        fields['commandGpuMsMedian']=median(gpu)
        fields['commandGpuMsP95']=sorted(gpu)[min(len(gpu)-1,int(len(gpu)*.95))] if gpu else None
        fields['sampledCommands']=len(gpu)
        fields['atlasUploadTotal']=sum(r.get('atlasUploads',0) for r in scene)
        fields['atlasByteTotal']=sum(r.get('atlasBytes',0) for r in scene)
        fields['atlasEvictionTotal']=sum(r.get('atlasEvictions',0) for r in scene)
        diags[label][name]=fields

doc={'measurements':all_rows,'diagnostics':diags}
for name in ['precise','markdown-cost']:
    p=evidence/name/'results.json'
    if p.exists():doc[name]=json.loads(p.read_text())
(evidence/'summary.json').write_text(json.dumps(doc,indent=2))
(app/'perf/gpu/results.json').write_text(json.dumps(doc,indent=2))
print(json.dumps(diags,indent=2))
