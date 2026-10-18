"""Preserve compact, reviewable results; raw ownership/region dumps stay external."""
from pathlib import Path
import json
import os
import statistics

here = Path(__file__).resolve().parent
evidence = Path(os.environ.get('KYBERN_MEMORY_EVIDENCE', '/Users/mymac/projects/ade/previews/gpuix/perf/memory'))
bench = here.parent / 'bench/results'

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

controls = [row for row in load(evidence / 'before-rerun-app/results.json')
            if row['group'] in ['thread-explorer-notes', 'terminal-stream']]
controls += load(evidence / 'before-extra-final-app/results.json')
result = {
    'diagnosticControls': {label: [compact(row) for row in load(evidence / label / 'results.json')]
                           for label in ['before-lab', 'image-only', 'arena-only', 'allocator-zones']},
    'featureControls': {label: load(bench / f'memory-{label}.json') for label in ['before-matched', 'after-disabled', 'after-matched']},
    'startupControls': {label: load(bench / f'memory-startup-{label}.json') for label in ['disabled', 'enabled', 'baseline']},
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
All numbers use `KYBERN_FULL_RATE=1`, unchanged rendering defaults, a scratch
daemon, 10-second warmup and 15-second resource windows. Scrolling/startup has
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

## Full product

{memory_table(result['appBefore'], result['appAfter'], True)}

The 3,000-turn traversal loads all earlier history and visits logical anchors
every 20 turns; it does not paint every pixel or every image. The image lab
separately traverses 48 large image sources twice. Active documents/hosts retain
their images, so the dormant-cache budgets do not bound all visible content.
WebKit candidate PIDs/resources remain separate in `results.json`; they are new
XPC services during this fixture and can be confounded by external app launches.

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
reclamation does not establish smoothness for every screen.

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

Metal counters showed a 2 MiB instance target and approximately 1 MiB of atlas
capacity after image closure in the isolated fixture. No Metal-pool shrinking
was added without evidence of a large retained pool. Image pixel estimates,
last-submission Metal device allocations, JS heap and physical footprint are
distinct measurements; native retained-tree bytes cannot be assigned exactly
from React node counts. No packaged startup or physical presentation-fence
measurement is claimed.
'''
here.joinpath('results.json').write_text(json.dumps(result, indent=2) + '\n')
here.joinpath('RESULTS.md').write_text(report)
print(report)
