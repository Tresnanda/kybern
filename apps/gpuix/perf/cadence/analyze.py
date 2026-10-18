"""Root-cause evidence from actual submission / React traces; no UI or timing."""
import json,re,math,statistics
from pathlib import Path
root=Path('/Users/mymac/projects/ade/previews/gpuix/perf/cadence')
rows=[]
for file in sorted(root.glob('cadence-*/*/*-*.log')):
 if '-setup-failed' in file.name:continue
 lines=file.read_text().splitlines();frames=[];commits=[]
 for index,line in enumerate(lines):
  m=re.search(r'\[kybern-submit\] ([\d.]+)',line)
  if m:frames.append((index,float(m[1])))
  m=re.search(r'\[pacing-commit\] ([\d.]+)',line)
  if m:commits.append((index,float(m[1])))
 gaps=[(a,b,b[1]-a[1]) for a,b in zip(frames,frames[1:]) if 180<=b[1]-a[1]<=220]
 count=[sum(a[0]<index<b[0] for index,_ in commits) for a,b,_ in gaps]
 intervals=[b[1]-a[1] for a,b in zip(commits,commits[1:])]
 rows.append({'path':str(file.relative_to(root)),'submissions':len(frames),'commits':len(commits),'gaps180to220':len(gaps),'gapsWithExactlyOneReactCommit':count.count(1),'gapsWithoutReactCommit':count.count(0),'coarseCommitIntervals180to220':sum(180<=dt<=220 for dt in intervals),'commitIntervalMedian':statistics.median(intervals) if intervals else None})
expected={}
for fling in [False,True]:
 values=[45*math.exp(-(phase-20)/35) if fling and phase>=20 else 45 if fling else 6*math.sin(math.pi*min(phase+1,30)/60) if phase<120 else 6*math.exp(-(phase-120)/45) for phase in range(300)]
 expected['fling' if fling else 'scroll']={'packets':1800,'integerZeroDistancePackets':6*sum(abs(v)<1 for v in values),'fractionalZeroDistancePackets':0,'momentumTailZeroStartsAtPhase':next(i for i,v in enumerate(values) if i>=120 and abs(v)<1)}
(root/'diagnostics'/'trace-correlation.json').write_text(json.dumps({'scope':'Raw logs include setup, warmup and earlier repeats; rows overlap cumulatively and must not be summed. Timed scenario JSON is authoritative.','expectedInjectorQuantization':expected,'traces':rows},indent=2))
print(json.dumps(expected,indent=2))
