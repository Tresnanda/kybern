"""Correlate every slow submission interval with bounded native/React telemetry.
No inference that a commit caused a stall, or a short draw proves a free frame.
Usage: python3 perf/flick/attribute.py <bench-json> <output-directory>
"""
import csv,json,re,sys
from pathlib import Path
source=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
doc=json.loads(source.read_text());summary=[];seen={}
for result in doc["results"]:
 name=result["scenario"];run=result["run"]
 # Retries reset run numbers. Match each result to its attempt in result order,
 # including discarded windows, so a valid retry is never attributed to its
 # discarded predecessor's log.
 key=(name,run);index=seen.get(key,0);seen[key]=index+1
 if result["status"]!="ok":continue
 logs=sorted(Path(doc["evidence"]).glob(f"{name}-attempt-*/{name}-{run}.log"),key=lambda p:int(p.parent.name.rsplit('-',1)[1]))
 assert index<len(logs),(name,run,index,len(logs))
 for log in logs[index:index+1]:
  rows=[];all_frames=[];cut=None;last=None;work=[];layouts=[];commits=0;packets=0;first=[];last_input=[]
  for line in log.read_text().splitlines():
   end=re.search(r"\[bench-window-end\] run=(\d+) native=([\d.]+)",line)
   if end and int(end[1])==run:cut=float(end[2])
   cost=re.search(r"\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)",line)
   if cost:work.append(float(cost[1]));layouts.append(float(cost[2]))
   if '[pacing-commit]' in line:commits+=1
   paint=re.search(r"\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+)",line)
   if paint:packets+=int(paint[1]);first.append(float(paint[2]));last_input.append(float(paint[3]))
   frame=re.search(r"\[kybern-submit\] ([\d.]+)",line)
   if not frame:continue
   at=float(frame[1]);gap=at-last if last is not None else 0
   if last is not None:
    cause='native draw exceeds 16.7 ms' if max(work,default=0)>16.7 else 'multiple native draws between submissions' if len(work)>1 else 'React commit correlated; causality unresolved' if commits else 'display/scheduler interval; no long measured draw'
    all_frames.append(dict(nativeMs=at,gapMs=gap,over33=gap>33,draws=len(work),drawSumMs=round(sum(work),3),drawMaxMs=max(work,default=0),layoutSumMs=round(sum(layouts),3),commits=commits,inputPackets=packets,inputFirstMaxMs=max(first,default=0),inputLastMaxMs=max(last_input,default=0),attribution=cause))
   last=at;work=[];layouts=[];commits=0;packets=0;first=[];last_input=[]
  if cut is None:continue
  if not result['frames']['count']:continue
  measured=[r for r in all_frames if r['nativeMs']<=cut][-result['frames']['count']:]
  # Continuous wheel workloads include the transition from the warmup's last
  # submission to the first measured one. A stall there must not disappear.
  continuous=name.endswith('scroll') or name=='thread-fling'
  rows=[r for r in (measured if continuous else measured[1:]) if r['gapMs']>16.7]
  assert len(rows)==result['frames']['over16_7'], (name,run,len(rows),result['frames'])
  assert sum(r['over33'] for r in rows)==result['frames']['over33']
  if not rows:continue
  stem=f'{name}-{run}-{log.parent.name}'
  with (out/(stem+'.csv')).open('w') as f:
   writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
  categories={}
  for row in rows:
   c=categories.setdefault(row['attribution'],{'over16_7':0,'over33':0});c['over16_7']+=1;c['over33']+=int(row['over33'])
  summary.append({'scenario':name,'run':run,'sourceLog':str(log),'rows':len(rows),'categories':categories,'over33':[r for r in rows if r['over33']]})
(out/'attribution.json').write_text(json.dumps({'source':str(source),'limitations':'Correlated log boundaries; not physical presents or exhaustive per-frame CPU stacks. Uninstrumented JS, GC, shaping and daemon work remain unresolved. Profile runs perturb cadence and must stay separate from acceptance.','results':summary},indent=2))
print(json.dumps([{'scenario':s['scenario'],'run':s['run'],'rows':s['rows'],'over33':len(s['over33'])} for s in summary],indent=2))
