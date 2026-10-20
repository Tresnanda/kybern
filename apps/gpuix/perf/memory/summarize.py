"""Preserve compact, reviewable results; raw ownership/region dumps stay external."""
from pathlib import Path
import json
import os
import statistics

here = Path(__file__).resolve().parent
evidence = Path(os.environ.get('KYBERN_MEMORY_EVIDENCE', '/Users/mymac/projects/ade/previews/gpuix/perf/memory'))
bench = here.parent / 'bench/results'
if not (bench / 'memory-before-final.json').exists():
    bench = evidence / 'bench-results'

def load(file):
    return json.loads(file.read_text())

def compact(row):
    assert not row['gate']['overlap'] and not row['gate']['orphanOverlap'], 'Discard contended samples'
    attribution = row['attribution']
    return {**{key: row[key] for key in ['name', 'fullRate', 'frames', 'proxy', 'work', 'resources']},
            'group': row.get('group'), 'jsHeapBytes': attribution['heap']['heapSize'],
            'native': attribution.get('native'), 'diagrams': attribution.get('diagrams'), 'preview': attribution.get('preview'), 'syntax': attribution.get('syntax'),
            'reactCounts': row.get('counters', {}).get('counts'),
            'webkitCandidates': row.get('webkitCandidates'), 'webkitResources': row.get('webkitResources'),
            'webkitSampleError': row.get('webkitSampleError'),
            'sceneSubmissionProxyMs': row.get('sceneSubmissionProxyMs'),
            'sceneSubmissionSamples': row.get('sceneSubmissionSamples'),
            'timedWindowStartedAt': row['gate']['timedWindowStartedAt'],
            'timedWindowEndedAt': row['gate']['timedWindowEndedAt']}

controls = load(evidence / 'before-product-final-app/results.json')
result = {
    'metadata': {label: load(evidence / label / 'metadata.json') for label in
                 ['before-final-lab', 'after-final-lab', 'before-product-final-app', 'after-final-app', 'after-code-repeat']},
    'diagnosticControls': {label: [compact(row) for row in load(evidence / label / 'results.json')]
                           for label in ['before-lab', 'image-only', 'arena-only', 'allocator-zones']},
    'featureControls': {label: load(bench / f'memory-{label}.json') for label in ['before-matched', 'after-disabled', 'after-matched']},
    'startupControls': {label: load(bench / f'memory-startup-{label}.json') for label in ['disabled', 'enabled', 'baseline']},
    'noteHeapAfter': [compact(row) for row in load(evidence / 'after-note-heap/results.json')] if (evidence / 'after-note-heap/results.json').exists() else [],
    'rejectedDetachedLayoutExperiment': {
        label: {'metadata': load(evidence / label / 'metadata.json'),
                'rows': [compact(row) for row in load(evidence / label / 'results.json')],
                'relief': load(evidence / label / 'allocator-relief.json')}
        for label in ['after-note-detach-off', 'after-note-detach-on']},
    'allocationDiagnosis': {
        'metadata': load(evidence / 'after-note-stacks/metadata.json'),
        'excludeTimingAndResources': True,
        'largeAllocationCount': 24,
        'reportedKiBEachWithLogging': 6160,
        'allocationSite': 'image::animation::Frame::clone in gpuix-native.darwin-arm64.node',
        'retainingOwner': 'unresolved',
        'historyFilterMissed': 'Requested 6291456 bytes; stack logging inflated the reported size to 6307840 bytes. Corrected helper not rerun.'},
    'visualDiff': load(evidence / 'visual-diff.json'),
    'cleanup': load(evidence / 'cleanup.json') if (evidence / 'cleanup.json').exists() else None,
    'labBefore': [compact(row) for row in load(evidence / 'before-final-lab/results.json')],
    'labAfter': [compact(row) for row in load(evidence / 'after-final-lab/results.json')],
    'codeRepeatAfter': [compact(row) for row in load(evidence / 'after-code-repeat/results.json')],
    'appBefore': [compact(row) for row in controls],
    'appAfter': [compact(row) for row in load(evidence / 'after-final-app/results.json')],
    'benchBefore': load(bench / 'memory-before-final.json'),
    'benchAfter': load(bench / 'memory-after-final.json'),
}
for doc in [result[f'bench{side}'] for side in ['Before', 'After']] + list(result['startupControls'].values()) + list(result['featureControls'].values()):
    assert not doc['aborted'] and all(row['status'] == 'ok' for row in doc['results'])
    # Raw logs are external. Keep all accepted individual repeats and the
    # source/addon/settings metadata, with just the gate/input evidence.
    for row in doc['results']:
        row['evidence'] = {key: value for key, value in row['evidence'].items() if key != 'resourceText'}

def fmt(value):
    return '—' if value is None else f'{value:.2f}'

def memory_table(before, after, grouped=False):
    rows = ['| Workload | Footprint MiB before → after | CPU % before → after | GPU ms / 15 s before → after | Submission p50/p95/p99 ms before → after | >16.7/>33 ms before → after |',
            '|---|---:|---:|---:|---|---:|']
    indexed = {(row.get('group'), row['name']): row for row in before}
    for row in after:
        key = (row.get('group'), row['name'])
        old = indexed[key]
        name = f"{row['group']} / {row['name']}" if grouped else row['name']
        def change(metric):
            return f"{fmt(old['resources'][metric])} → {fmt(row['resources'][metric])}"
        frames = ' → '.join('/'.join(fmt(value['frames'][key]) for key in ['p50', 'p95', 'p99']) for value in [old, row])
        over = ' → '.join('/'.join(str(value['frames'][key]) for key in ['over16_7', 'over33']) for value in [old, row])
        rows.append(f"| {name} | {change('footprintMiB')} | {change('cpuPercent')} | {change('gpuMs')} | {frames} | {over} |")
    return '\n'.join(rows)

def heap_table():
    rows = ['| Thread/Explorer/note stage | JS heap MiB before → after | React host-node count before → after |',
            '|---|---:|---:|']
    old = {row['name']: row for row in result['appBefore'] if row['group'] == 'thread-explorer-notes'}
    for row in result['appAfter']:
        if row['group'] != 'thread-explorer-notes':
            continue
        previous = old[row['name']]
        heap = ' → '.join(fmt(value['jsHeapBytes'] / 1048576) for value in [previous, row])
        hosts = ' → '.join(str(sum(count['hostNodes'] for count in (value['reactCounts'] or {}).values())) for value in [previous, row])
        rows.append(f"| {row['name']} | {heap} | {hosts} |")
    return '\n'.join(rows)

def repeat_table():
    rows = ['| Code-only stage | Footprint MiB | Layout node high water |', '|---|---:|---:|']
    for row in result['codeRepeatAfter']:
        rows.append(f"| {row['name']} | {fmt(row['resources']['footprintMiB'])} | {row['native']['layoutNodeHighWater']} |")
    return '\n'.join(rows)

def benchmark_table():
    rows = ['| Scenario | Side | p50/p95/p99 ms | >16.7/>33 ms | Submission proxy p95 ms | CPU % | GPU ms / 15 s | MiB |',
            '|---|---|---|---:|---:|---:|---:|---:|']
    scenarios = list(dict.fromkeys(row['scenario'] for row in result['benchBefore']['results']))
    for scenario in scenarios:
        for side in ['Before', 'After']:
            runs = [row for row in result[f'bench{side}']['results'] if row['scenario'] == scenario]
            def median(get):
                values = [get(row) for row in runs if get(row) is not None]
                return statistics.median(values) if values else None
            frames = '/'.join(fmt(median(lambda row: row['frames'][key])) for key in ['p50', 'p95', 'p99'])
            if median(lambda row: row['frames']['count']) == 0:
                frames = '—/—/—'
            over = '/'.join(fmt(median(lambda row: row['frames'][key])) for key in ['over16_7', 'over33'])
            resources = [fmt(median(lambda row: row['resources'][key])) for key in ['cpuPercent', 'gpuMs', 'footprintMiB']]
            proxy = fmt(median(lambda row: row['latency']['proxyMs']['p95']))
            rows.append(f"| {scenario} | {side.lower()} | {frames} | {over} | {proxy} | {' | '.join(resources)} |")
    return '\n'.join(rows)

def startup_controls_table():
    rows = ['| Fresh control | Startup | Shell median ms | First content median ms |',
            '|---|---|---:|---:|']
    for label, doc in result['startupControls'].items():
        for scenario in ['startup-cold', 'startup-warm']:
            runs = [row for row in doc['results'] if row['scenario'] == scenario]
            values = [fmt(statistics.median(row['timings'][key] for row in runs))
                      for key in ['firstPaintedShellMs', 'firstContentMs']]
            rows.append(f"| {label} | {scenario} | {' | '.join(values)} |")
    return '\n'.join(rows)

def feature_controls_table():
    rows = ['| Control (RPC input) | Scenario | CPU % | Render p95 ms | Footprint MiB |',
            '|---|---|---:|---:|---:|']
    for label, doc in result['featureControls'].items():
        for scenario in ['thread-scroll', 'markdown-scroll']:
            runs = [row for row in doc['results'] if row['scenario'] == scenario]
            assert len(runs) == 3 and all(row['evidence']['forcedRpc'] for row in runs)
            cells = [fmt(statistics.median(row['resources']['cpuPercent'] for row in runs)),
                     fmt(statistics.median(row['work']['renderMs']['p95'] for row in runs)),
                     fmt(statistics.median(row['resources']['footprintMiB'] for row in runs))]
            rows.append(f"| {label} | {scenario} | {' | '.join(cells)} |")
    return '\n'.join(rows)

def work_table():
    rows = ['| Scenario | Side | Render p95 ms (includes layout) | Included layout p95 ms | React commits / window |',
            '|---|---|---:|---:|---:|']
    scenarios = list(dict.fromkeys(row['scenario'] for row in result['benchBefore']['results']))
    for scenario in scenarios:
        if scenario.startswith('startup'):
            continue
        for side in ['Before', 'After']:
            runs = [row for row in result[f'bench{side}']['results'] if row['scenario'] == scenario]
            values = []
            for metric in ['renderMs', 'layoutMs']:
                samples = [row['work'][metric]['p95'] for row in runs if row['work'][metric]['p95'] is not None]
                values.append(fmt(statistics.median(samples)) if samples else '—')
            if statistics.median(row['frames']['count'] for row in runs) == 0:
                values = ['—', '—']
            commits = fmt(statistics.median(row['work']['reactCommits'] for row in runs))
            rows.append(f"| {scenario} | {side.lower()} | {' | '.join(values)} | {commits} |")
    return '\n'.join(rows)

def startup_table():
    rows = ['| Startup | Shell ms before → after | First content ms before → after |',
            '|---|---:|---:|']
    for scenario in ['startup-cold', 'startup-warm']:
        cells = []
        for metric in ['firstPaintedShellMs', 'firstContentMs']:
            values = []
            for side in ['Before', 'After']:
                samples = [row['timings'][metric] for row in result[f'bench{side}']['results']
                           if row['scenario'] == scenario]
                values.append(fmt(statistics.median(samples)))
            cells.append(' → '.join(values))
        rows.append(f"| {scenario} | {' | '.join(cells)} |")
    return '\n'.join(rows)

meta = result['benchAfter']
report = f'''# Native memory results

{meta['hardware']}, macOS {meta['host']}, Bun {meta['bun']}, {meta['display']}.
All numbers use `KYBERN_FULL_RATE=1`, unchanged rendering defaults and a scratch
daemon. Resource samples use 10-second warmup and 15-second windows; startup
uses separate fresh-process probes. Scrolling/startup has
three accepted repeats per scenario; memory stages are single settled samples.
CPU is percent of one core; GPU time and physical footprint come from the shared
native sampler. RSS is not used. Raw evidence: `{evidence}`.

The memory stages are settled snapshots, not scrolling frame-rate tests. Their
full frame distributions, counts, native counters, JS heap observations and
timestamps are retained in `results.json`. The full-product Home keeps the
synthetic running sidebar row, whose 200 ms updates are intentional. The
separate idle-home scenario removes it. Startup submission gaps are not dropped
animation frames. Idle interval/work distributions are omitted when the median
window has zero submissions; any first-window transition frames remain in the
individual raw results. Latency is offered input to next scene-submission stderr
receipt; physical input-to-present latency is unavailable.

## Image and code round trip

{memory_table(result['labBefore'], result['labAfter'])}

A separate code-only process repeats the code → Home transition twice; its
accepted footprints and native counters are retained under `codeRepeatAfter`
in `results.json`. This separates a reusable high-water allocation from growth
on each visit.

{repeat_table()}

## Full product

{memory_table(result['appBefore'], result['appAfter'], True)}

The 3,000-turn traversal loads all earlier history and visits logical anchors
every 20 turns; it does not paint every pixel or every image. The image lab
separately traverses 48 large image sources twice. Active documents/hosts retain
their images, so the dormant-cache budgets do not bound all visible content.
WebKit candidate PIDs/resources remain separate in `results.json`; they are new
XPC services during this fixture and can be confounded by external app launches.

{heap_table()}

These are single settled samples. Garbage-collection timing differs visibly: the
baseline retains its large JS heap through Explorer/note, whereas the final run
collects it earlier. Do not attribute the entire full-product difference to
native image eviction. Active 3,000-turn data still consumes hundreds of MiB;
React counts are structural observations, not exact native-tree or Fiber bytes.
The returned Home footprint remains well above its initial level despite empty
image caches; this pass does not establish universal return to baseline.

## Startup and scrolling regression suite

{benchmark_table()}

{startup_table()}

{work_table()}

Thread and Markdown rows use a follow-up matched RPC-input control, with the
same 120 Hz contact/momentum schedule on both addons. The original Markdown
comparison selected different AppKit/RPC backends and is archived separately
under `*-mixed-input.json`; it is excluded from performance claims.

{feature_controls_table()}

The follow-up startup control uses three fresh processes per scenario, ordered
final addon with all memory features disabled, final addon enabled, then baseline.
It is a timing control rather than a randomized experiment. Flags and addon
hashes are retained with each control.

{startup_controls_table()}

Startup content timings and per-frame CPU render/layout distributions remain in
`results.json`. This 60 Hz display does not demonstrate 120 Hz readiness. The
existing Markdown/layout workload can exceed an 8.3 ms CPU budget; memory
reclamation does not establish smoothness for every screen. The first startup
batch was slower on the final addon; the fresh enabled/disabled/baseline control
did not reproduce that slowdown. Explorer interval p95 increased by 1.22 ms even
though render p95 changed by 0.27 ms and CPU was unchanged. GPU time varied
substantially, including a higher thread-scroll total; no uniform GPU or energy
improvement is claimed. These tails need a combined integration recheck.

## Isolation and remaining footprint

The early exploratory controls use the same host and 15-second resource windows,
but predate per-stage ten-second warmup and addon-hash metadata. They are retained
separately under `diagnosticControls`; final matched runs above are the acceptance
evidence.

The original image lab retained about 288 MiB of decoded pixels plus roughly
288 MiB of image atlas pixels after its first carousel. Closing the image
screen now drops both owners, and editor images are released on screen close.
Shared visible/overscan owners and editor undo/redo references stay protected.
The code case grows Taffy storage to about 48,000 nodes; replacing its retained
slot storage after a large collapse reduced its isolated Home footprint from
439 MiB to 299 MiB in the image-only versus frame-storage control.

The separate code-only allocator probe measured 143 → 405 → 265 MiB. `heap`
reported 37.7 MiB of live malloc allocations; the footprint region histogram
reported 105 MiB as reclaimable Malloc Small pages. Both all-zone and explicit
default-zone `malloc_zone_pressure_relief` calls returned zero and did not lower
the physical footprint. The ineffective production allocator call was removed.
Residual footprint is reported rather than subtracted as if reclaimed.

A stricter editable-note probe loads 24 images in one document. Its final-addon
footprint was 144 → 322 → 307 MiB even though the editor image cache dropped from
24 entries to zero. Heap inspection reported 24 remaining 6 MiB allocations.
An additional experiment cleared detached editor layout storage at a safe frame
boundary. Its counter confirmed execution, but the disabled and enabled round
trips were 144 → 334 → 319 and 144 → 335 → 320 MiB respectively. Allocator relief
again released zero bytes. That native experiment was reverted; its patch and
negative-control measurements are retained separately for review.

The final allocation-diagnosis run used the production addon and native-child
stack logging. Its heap attributed 24 allocations (144.4 MiB including logging
overhead) to `image::animation::Frame::clone` in the native addon. This identifies
the allocation site, not the retaining owner. The exact-size `malloc_history`
filter missed them because logging inflated 6,144 KiB to 6,160 KiB. The helper
now uses the observed size, but that correction was only typechecked. No timing
or resource values from the logging run are used in acceptance comparisons.

Metal counters showed a 2 MiB instance target and approximately 1 MiB of atlas
capacity after image closure in the isolated fixture. No Metal-pool shrinking
was added without evidence of a large retained pool. Image pixel estimates,
last-submission Metal device allocations, JS heap and physical footprint are
distinct measurements; native retained-tree bytes cannot be assigned exactly
from React node counts. No packaged startup or physical presentation-fence
measurement is claimed.

## Shipped changes and validation

Native patches are separate from product JavaScript: `image_memory_gpui.py`,
`image_memory.rs` and `image_memory_hooks.py` add source leases, byte bounds,
asset-task and atlas eviction, and GPU-safe atlas reuse. `rich_editor.rs` tracks
document/undo image owners, bounds dormant images, drains atlas removals and
exposes actual image residency. `frame_memory_gpui.py` shrinks oversized frame
arenas and replaces Taffy storage after a large collapse. `memory_counters_gpui.py`
and the minimal backdrop hook expose opt-in Metal ownership counters.

`src/editor/images.ts` verifies native residency before reusing a resolved load,
shares in-flight work, avoids retaining large data-URL keys, and passes the exact
Buffer byte range. Transcript/windowing/Markdown product code was not changed.
The `perf/memory` fixtures, matched-input benchmark hooks, native UI leases and
process-group cleanup make the measurement and validation runs reproducible.

The production addon SHA-256 is
`91ad37caae54c6cceda948d17607859318a5ffee9a707e69fc888fcf38f14e58`;
the baseline is
`17ecd86ebd97c1fae86839ef31e41ceaf0b73027a31162a18638f155163adabe`.
The successful production `native/update.sh` output is `native-update.log`
(also `native-update-3.log`) in the evidence folder. The rejected experimental
build log is separate and does not validate a different shipped binary.

Checks passed: complete production native update/check suite, eight frame-arena
unit tests, spring/rich-document Rust tests, product/native/tooling TypeScript,
`bun test ./src` (322 tests, 5,813 assertions, 49 files), editor-image unit tests,
and UI-lease child/grandchild cleanup. A pre-existing baseline line-layout cache
panic invalidated one initial Explorer process; its evidence was archived and
three fresh repeats passed. This lane does not claim to fix that crash.

The 16 before/after visual pairs cover both themes, rounded images, a shared
visible peer through 47 evictions, image/editor reopen, failed-load retry and
code closure. All 3,144,192 sampled functional-canvas pixels matched, excluding
window chrome/corners. Actual light editor-reopen and dark shared-peer captures
were also inspected. Evidence is under `before-final-visual/`,
`after-final-visual/` and `visual-diff.json`.

Integration must preserve the Markdown lane's additional document checks when
combining `native/check-update.sh` and `update.sh`; this branch started before
those checks existed. Combined startup, scrolling and GPU tails need a recheck.
'''
if result['cleanup']:
    cleanup = result['cleanup']
    report += f'''
## Cleanup

Free space was approximately {cleanup['initialFreeGiB']} GiB before task builds.
Immediately before/after cleanup it was
{cleanup['beforeCleanupFreeBytes'] / 1073741824:.2f} → {cleanup['afterCleanupFreeBytes'] / 1073741824:.2f} GiB
on the shared APFS volume; other lanes can change that volume concurrently.
Removed this task's native target (1.8 GiB), generated upstream (185 MiB),
disposable GPUIX/desktop dependencies (188/633 MiB), scratch data (119 MiB),
baseline/intermediate addons and generated unit-test binaries. The validated
25 MiB final addon and 104 KiB runtime bridge remain for integration. Evidence
and benchmark archives remain outside the worktree. No own fixture, sampler,
build, daemon listener or open native build file remained before deletion.
'''
here.joinpath('results.json').write_text(json.dumps(result, indent=2) + '\n')
here.joinpath('RESULTS.md').write_text(report)
print(report)
