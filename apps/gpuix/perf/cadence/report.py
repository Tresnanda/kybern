"""Assemble small review tables from retained raw JSON. No UI launches."""
import json,statistics,shutil,re
from pathlib import Path
app=Path(__file__).resolve().parents[2]
out=Path('/Users/mymac/projects/ade/previews/gpuix/perf/cadence')
results=app/'perf/bench/results'
def read(p):return json.loads(p.read_text())
def fmt(v):return '—' if v is None else f'{v:.2f}'
def median(rows,path):
 vals=[]
 for row in rows:
  value=row
  for key in path.split('.'):
   value=value.get(key) if isinstance(value,dict) else None
  if value is not None:vals.append(value)
 return statistics.median(vals) if vals else None
def bench_table(before,after):
 lines=['| Scenario | Source | p50 / p95 / p99 ms | >16.7 / >33 | Max gap | Proxy p95 | CPU % | GPU ms/15s | MiB |','|---|---|---|---|---:|---:|---:|---:|---:|']
 for scenario in ['thread-scroll','thread-fling','sidebar-scroll','explorer-scroll','markdown-scroll','code-scroll','open-long','older-history']:
  for label,doc in [('before',before),('after',after)]:
   rows=[r for r in doc['results'] if r['scenario']==scenario and r['status']=='ok']
   m=lambda p:fmt(median(rows,p))
   lines.append(f"| {scenario} | {label} ({len(rows)}) | {' / '.join(m('frames.'+p) for p in ['p50','p95','p99'])} | {m('frames.over16_7')} / {m('frames.over33')} | {m('frames.max')} | {m('latency.proxyMs.p95')} | {m('resources.cpuPercent')} | {m('resources.gpuMs')} | {m('resources.footprintMiB')} |")
 return '\n'.join(lines)
def loops_table():
 lines=['| Scene | Control | Frames | p50/p95/p99 ms | >16.7/>33 | Max gap | React commits | CPU % | GPU ms/15s | MiB | Clipped / minimized / unmounted frames |','|---|---|---:|---|---|---:|---:|---:|---:|---:|---|']
 for source,mode in [('before','default'),('after','default'),('after','native'),('before','native')]:
  file=out/'loops'/f'{source}-{mode}-resources.json'
  if not file.exists():continue
  for r in read(file):
   f=r['frames'];p=r['parked'];v=r['resources']
   lines.append(f"| {r['scene']} | {source} {mode} | {f['count']} | {' / '.join(fmt(f[x]) for x in ['p50','p95','p99'])} | {f['over16_7']} / {f['over33']} | {fmt(f['max'])} | {r['work']['reactCommits']} | {fmt(v['cpuPercent'])} | {fmt(v['gpuMs'])} | {fmt(v['footprintMiB'])} | {' / '.join(str(p[x]['frames']['count']) for x in ['clipped','minimized','unmounted'])} |")
 return '\n'.join(lines)
def extra_tables(after):
 lines=['## Settled controls','', '| Scenario | Repeat | Frames | React commits | CPU % | GPU ms/15s | MiB |','|---|---:|---:|---:|---:|---:|---:|']
 for label in ['cadence-after-settled-3','cadence-after-idle-settled20-3','cadence-after-idle-limits-3']:
  file=results/(label+'.json')
  if not file.exists():continue
  for r in read(file)['results']:
   v=r['resources'];lines.append(f"| {r['scenario']} ({20 if 'settled20' in label or 'idle-limits' in label else 10}s warmup) | {r['run']} | {r['frames']['count']} | {r['work']['reactCommits']} | {fmt(v['cpuPercent'])} | {fmt(v['gpuMs'])} | {fmt(v['footprintMiB'])} |")
 lines+=['','## Content visibility timings','','| Scenario | Source | First visible message ms | Settled text ms | Older turn visible ms |','|---|---|---:|---:|---:|']
 for source in ['before','after']:
  doc=read(results/f'cadence-{source}-direct-3.json')
  for name in ['open-long','older-history']:
   rows=[r for r in doc['results'] if r['scenario']==name and r['status']=='ok']
   lines.append(f"| {name} | {source} | {fmt(median(rows,'timings.firstVisibleMessageMs'))} | {fmt(median(rows,'timings.settledMs'))} | {fmt(median(rows,'timings.olderHistoryVisibleMs'))} |")
 lines+=['','Open/history resource samples begin immediately after the visibility check, so','finite scrolling/scrollbar tails remain in those windows. Occasional late data','commits are shown rather than labelled as continuous animation. The first Home','window at ten seconds contained two finite commits; the separate twenty-second','Home control crosses the first minute poll. Its final window exposed one unchanged usage-limits publication; the dedicated idle-limits control verifies its deduplication. All three initial thread-idle windows','were already zero-frame.','', '## Per-submission active cost','', '| Scenario | CPU ms/submission | AGX ms/submission | Render p95 ms | Taffy p95 ms |','|---|---:|---:|---:|---:|']
 for name in ['thread-scroll','thread-fling','sidebar-scroll','explorer-scroll','markdown-scroll','code-scroll']:
  rows=[r for r in after['results'] if r['scenario']==name and r['status']=='ok'];m=lambda p:fmt(median(rows,p))
  lines.append(f"| {name} | {m('evidence.averageProcessCpuMsPerSubmission')} | {m('evidence.averageProcessGpuMsPerSubmission')} | {m('work.renderMs.p95')} | {m('work.layoutMs.p95')} |")
 lines+=['','CPU/AGX averages include all process work in the window and are not per-frame','CPU/GPU duration fences. These controls do not establish 120 Hz readiness.','', '## Independent native-thread input controls','', '| Scene | Source | p50/p95/p99 ms | >16.7/>33 | Max gap | Dispatch-to-CPU-paint p95 | CPU % | GPU ms/15s | MiB |','|---|---|---|---|---:|---:|---:|---:|---:|']
 for source in ['before','after']:
  for area in ['sidebar','explorer']:
   file=out/'original-harnesses'/area/f'cadence-{source}-dark.json'
   if not file.exists():continue
   for r in read(file)['results']:
    resource=re.search(r'total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms',r['resourceText'])
    ram,cpu,gpu=map(float,resource.groups())
    lines.append(f"| {area}/{r['scene']} | {source} | {' / '.join(fmt(r[x]) for x in ['p50','p95','p99'])} | {r['over16_7']}/{r['over33']} | {fmt(r['max'])} | {fmt(r['inputToCpuPaintP95'])} | {fmt(cpu)} | {fmt(gpu)} | {fmt(ram)} |")
 lines+=['','These are supplemental single repeats with their earlier synthetic fixtures,','1440×900 windows and independent 120 Hz background native producer; they are','not interchangeable with the shared bench workload.','', '## Mounted but clipped resources','', '| Scene | Source / mode | Frames | CPU % | GPU ms/15s | MiB |','|---|---|---:|---:|---:|---:|']
 for source,mode in [('before','default'),('after','default'),('after','native'),('before','native')]:
  file=out/'loops'/f'{source}-{mode}-resources.json'
  if not file.exists():continue
  for r in read(file):
   c=r.get('clippedResources')
   if c:
    v=c['resources'];lines.append(f"| {r['scene']} | {source} {mode} | {c['frames']['count']} | {fmt(v['cpuPercent'])} | {fmt(v['gpuMs'])} | {fmt(v['footprintMiB'])} |")
 lines+=['','## Explicit visible Spin repeat','','| Source | Count | p50/p95/p99 ms | >16.7/>33 | Max gap | CPU % | GPU ms/15s | MiB |','|---|---:|---|---|---:|---:|---:|---:|']
 for source in ['before','after']:
  file=out/'loops-repeat'/f'{source}-default-resources.json'
  if not file.exists():continue
  for r in read(file):
   f=r['frames'];v=r['resources'];lines.append(f"| {source} | {f['count']} | {' / '.join(fmt(f[x]) for x in ['p50','p95','p99'])} | {f['over16_7']} / {f['over33']} | {fmt(f['max'])} | {fmt(v['cpuPercent'])} | {fmt(v['gpuMs'])} | {fmt(v['footprintMiB'])} |")
 return '\n'.join(lines)
before=read(results/'cadence-before-direct-3.json');after=read(results/'cadence-after-direct-3.json')
text='''# Cadence measurements

Synthetic 300-thread/20-project product dataset, mixed 1,000/3,000-turn
conversations, 10,000-entry Explorer and long Markdown/code previews. macOS
Apple M1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina display, KYBERN_FULL_RATE=1, unchanged combined addon SHA256
f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10.
Each shared-bench source has three successful 15-second windows, ten-second
warmups, no screenshots or clock manipulation. Before is the exact product
modules from b14b10f1 via control.ts; after is the visibility-gated source.
Both use identical fractional direct-handler input. The later usage-limits no-op fix is verified separately across the minute boundary; the active table isolates the visibility change. Values below are medians
across successful repeats, not pooled distributions. GPU is process AGX
accumulated time and footprint is physical MiB; daemon/WindowServer excluded.
Physical presentation latency remains unavailable.

## Apparatus/root cause

The original NSEvent getter truncated fractional points (613/1,800 zero-distance
offers in thread-scroll). Fixing getters alone left the gaps. In the five-second
same-source probe, NSWindow routing delivered 239/600 packets synchronously to
the actual GPUI handler, with or without exact getters. Direct scrollWheel:
delivered 600/600 and exactly the requested absolute distance. Window/fractional
p99 was 199.97 ms and proxy p95 137.67 ms; direct/fractional was 19.59 ms and
17.20 ms. A direct/integer probe delivered 600/600 at p99 19.01 ms while still rounding
205 offers to zero (1,851.76 requested versus 1,665 px delivered). NSWindow
routing causes the cadence suppression; getter precision fixes independent
motion-distance loss. Direct dispatch costs more CPU/GPU because it actually
delivers all events. These numbers are apparatus corrections, not product wins.

The surviving 200 ms submissions are the approved shared MatrixLoader timer.
Every non-idle benchmark keeps a synthetic running sidebar row, including the
open/history resource windows. Raw submission/React-commit correlation and
source timer audit are in diagnostics/trace-correlation.json and AUDIT.md.
Those resource windows are active-loader observations, not a 5 Hz loading poll.

## Matched product comparison

'''+bench_table(before,after)+'''

No active-scroll speedup is claimed for clipping subscriptions: these scenes
retain their one visible loader. Most differences are within the benchmark's
1 ms p95 / 3 CPU-point noise bands. The fast fling still has larger occasional
gaps; the root-cause fix does not prove all scrolling meets its frame budget.
Native input telemetry separately records GPUI dispatch-to-CPU-scene time.
Neither that boundary nor offered-to-next-submission is physical presentation.

## Passive controls

One resource window per isolated scene after ten seconds warmup. Native on/off
changes display-rate workload and is a gate check, not a matched visual-default
speedup. Parking checks settle one second then count submissions for 1.2 seconds.
Mounted-and-clipped Matrix/connection also have a full 15-second resource sample.
Exact telemetry `windowMs` and resource `sampleSeconds` remain in raw JSON;
submission counts include sampler endpoint collection. Sparse 200/500/1000 ms
passive intervals are intended discrete updates, not delayed input frames.
Passive fixtures offer no input, so their latency proxy is unavailable.

Visible-loop GPU readings varied substantially. Spin's initial before/after
pair was 252.6 / 1282.4 ms, while an explicit same-source repeat was 59.0 / 62.5
ms (CPU 4.45 / 4.06%, 925 / 924 submissions). Both repeats retain valid screen,
build and orphan checks in `loops-repeat/`; none is silently substituted for
the first pair. These single-pass passive resources do not establish a general
visible-loop GPU improvement or regression. The durable clipping result is
zero submissions, commits and AGX work, with CPU returning to the idle range.

The opt-in connection comparison cuts per-display React commits from 924 to
zero, CPU 6.85 to 3.72%, and GPU 76.7 to 53.6 ms in its one matched 15-second
control. Its same-period native rotation is retained under the existing opt-in.
The global native-default gate remains unmet: shimmer's native sample used
67.4 versus 39.6 ms in its legacy sample, GPU controls have the variance above,
and no new full-app native on/off acceptance establishes that the historical
failure is gone. Experimental native defaults remain off.

'''+loops_table()+'\n\n'+extra_tables(after)+'''

## Evidence integrity

The original integer sidebar repeat 2 overlapped this lane's TypeScript check
at about 15:08:44Z and is excluded; repeats 1/3 plus the explicit clean sidebar
replacement provide three uncontaminated legacy observations. Its raw row stays
preserved. The getter-only fractional suite was intentionally aborted after it
failed to cure routing suppression, and is diagnostic only. No aborted suite
is used as matched product acceptance. Raw trace rows contain cumulative setup,
warmup and earlier repeats; do not sum them as independent timing samples.

## Source changes and visual evidence

- `src/native/loop-visibility.ts` and its reconciler test observe native painted
  bounds without a clock or frame request; null/empty/outside clips unsubscribe.
- `MatrixLoader.tsx`, `tasks/Glyphs.tsx`, `shell/Connection.tsx`,
  `transcript/Visual.tsx` and `transcript/motion.tsx` gate sampled clocks and
  native paint props by actual paint. Connection's explicitly enabled continuous
  arc uses existing native rotate at the same 1300 ms period.
- `kit/Spin.tsx` and `kit/Skeleton.tsx` park native plans and occlusion listeners
  while clipped; Skeleton retains its desktop-compatible reduced-motion sweep.
- `subagents/Elapsed.tsx` / `transcript/Turn.tsx` park informational seconds;
  `transcript/rows.tsx` supplies actual prose visibility to the blink effect.
  `ui.tsx` forwards Label refs without changing its host/style.
- `nav/limits.ts` / `nav/live.ts` preserve equal cached usage arrays, including
  all freshness/retry metadata. The integration test observes the real store:
  repeated cached polls notify nothing, while values, freshness and refreshing
  changes still publish. The prior minute poll generated one unchanged Home
  commit/submission at about 60 seconds despite twenty seconds warmup.
- `perf/bench` repairs input dispatch/precision, retains handler/distance evidence,
  separates native dispatch-to-CPU paint telemetry, and guards leases with
  independent forked sessions plus recoverable root/PID tokens. Queue cleanup
  and stale-lock cleanup serialize through Python. Signal disposal is bounded.
- `perf/scroll2` / `perf/explorer` add scratch/evidence overrides only;
  `perf/cadence` supplies same-addon source controls and independent captures.

No native patch changed. Getter-only dispatch was tested and rejected as a
cadence fix; enabling experimental native defaults remains subject to the
historical GPU gate. AUDIT.md identifies visible legacy clocks and terminal /
platform polling that remain; full P6 GPU conversion is not claimed.

The 936 raw loop PNGs produce 52 before/after strips in `strips/`, covering both
themes and reduced-motion states for default and affected opt-in paths. All 22
static reduced-motion crop comparisons have zero changed pixels. Animated
strips use real-clock phase sequences, not phase-aligned pixel assertions.
Full product Sidebar/thread/menu and Explorer/Markdown screenshots are under
`original-harnesses/{sidebar,explorer}/cadence-{before,after}-visual-*`.
No screenshots were taken during resource samples.

Screen validity was audited after the parent discovered a locked session from
about 16:30Z. All accepted shared-bench, supplementary native-input and visual
runs completed by 16:24:03Z, with positive active submissions/GPU.
The passive resource suite ran after unlock at 17:26–17:46Z, and its screen
endpoints are all unlocked/awake. A later idle-limits suite records its own
screen/build/orphan endpoints. The later
zero-visible-frame smoke was aborted and discarded before resources. Subsequent
runs record unlocked/awake Swift endpoints and use runner-scoped caffeinate;
continuous active zero/near-zero frame or zero GPU samples are rejected.
`diagnostics/screen-validity-audit.json` retains the retrospective audit.
Inactive dock panels unmount through `src/dock/Dock.tsx`'s active-tab conditional;
loop fixtures separately check unmount teardown as well as retained clipping.

See README.md for reproduction, AUDIT.md for passive paths and retained gaps,
and diagnostics/*cleanup.json for real crash/kill/timeout cleanup controls.
No native patch or rebuild was required by this source/injector change.
'''
cleanup=out/'diagnostics/cleanup.json'
if cleanup.exists():
 c=read(cleanup);text+=f"\n\n## Validation and cleanup\n\nRequired product/native/bench/cadence TypeScript checks and source/model tests\npassed; raw command logs and the complete source hash are in diagnostics/.\nNo native patch changed or native build was required.\nFree disk before this lane was approximately 82 GiB; before cleanup\n{c['freeGiBBeforeCleanup']:.2f} GiB and after cleanup {c['freeGiBAfterCleanup']:.2f} GiB\n(actual volume free space, not the sum of removed directory sizes).\nRemoved disposable GPUiX/desktop dependencies, scratch data, compiled wheel\nhelpers and this lane's Swift module cache. No Rust target was created.\nThe inherited signed addon remains for review; requested evidence remains here.\nBranch is gpuix/perf-cadence; FINAL-STATUS.json records final commit/status.\n"
(app/'perf/cadence/MEASUREMENTS.md').write_text(text)
(out/'MEASUREMENTS.md').write_text(text)
# Small JSON and median tables are durable review evidence outside the worktree.
archive=out/'results';archive.mkdir(exist_ok=True)
for file in results.glob('cadence-*'):
 if file.suffix in ['.json','.md']:shutil.copy2(file,archive/file.name)
print('Wrote',out/'MEASUREMENTS.md')
