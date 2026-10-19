"""Inclusive sampled stack counts; categories overlap and are not frame timings."""
import json,re,sys
from pathlib import Path
root=Path('/Users/mymac/projects/ade/previews/gpuix/perf/flick');results={}
patterns={'shaping':r'CTLineCreate|CTTypesetter|text_system.*(?:layout_line|layout_wrapped)','gc':r'Heap::collect|collect.*garbage|GCThread|MarkingConstraint','flush':r'App13flush_effects','build':r'renderer13build_element','taffy':r'compute_flexbox_layout','draw':r'Window4draw','wait':r'kevent64|semaphore_timedwait_trap'}
for label in sys.argv[1:] or ['profile-full','profile-frame']:
 raw=(root/label/'thread-fling-attempt-1/profile-thread-fling-1.txt').read_text();values={}
 for category,pattern in patterns.items():
  rows=[]
  for line in raw.splitlines():
   m=re.match(r'\s*[+|!: ]*(\d+)\s+(.+)',line)
   if m and re.search(pattern,m[2],re.I):rows.append({'count':int(m[1]),'symbol':m[2]})
  values[category]=sorted(rows,key=lambda r:r['count'],reverse=True)[:3]
 results[label]=values
(root/'profiles-summary.json').write_text(json.dumps({'meaning':'Largest inclusive stack counts; overlapping, not wall percentages. Stripped Bun/JIT symbols limit JS/GC attribution. Profiling perturbs cadence.','results':results},indent=2))
print(json.dumps({label:{key:values[key][0]['count'] if values[key] else None for key in patterns} for label,values in results.items()},indent=2))
