"""Largest inclusive samples; categories overlap and are not wall-time shares."""
import pathlib,re,json
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2')
patterns={'motionSync':r'sync_motion_states','motionFrame':r'sync_motion_frame','taffy':r'taffy::|flexbox::|compute_flexbox|compute_cached_layout','shape':r'CoreText|CTLine|shape_line|shape_text|text_system|text_layout','hash':r'Hasher|hash_slice|hashbrown','style':r'retained_tree|update_style|resolve_style','list':r'VirtualListEntry|build_virtual_list|ListStateInner','bridge':r'call_js_cb|apply_batch|applyBatch'}
result=[]
files=sorted([*out.glob('transcript/*sample.txt'),*out.glob('sidebar/*sample.txt'),*out.glob('initial-metrics/transcript/*sample.txt')])
for p in files:
 entries=[]
 for line in p.read_text().splitlines():
  m=re.match(r'^\s*[+|!: ]*(\d+)\s+(.+)',line)
  if m:entries.append((int(m[1]),m[2]))
 row={'file':str(p),'categories':{}}
 for category,pattern in patterns.items():
  matches=[v for v in entries if re.search(pattern,v[1],re.I)]
  row['categories'][category]=max(matches,key=lambda v:v[0]) if matches else None
 result.append(row)
(out/'profiles.json').write_text(json.dumps(result,indent=2))
for row in result:print(pathlib.Path(row['file']).name,{k:v[0] if v else None for k,v in row['categories'].items()})
