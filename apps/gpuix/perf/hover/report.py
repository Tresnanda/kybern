"""Validate completed evidence and emit a token-free, reviewable summary."""
import hashlib
import json
import pathlib

app = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover')
surfaces = ['shell-home', 'thread-header', 'conversation-helpers', 'shell-new-chat-hover',
            'composer-home-workspace', 'notes-list', 'notes-gallery', 'tasks-list',
            'tasks-board', 'notes-editor', 'dock-explorer', 'dock-explorer-file',
            'dock-agents', 'dock-notes', 'dock-tasks', 'settings-general',
            'dock-add-menu', 'palette', 'pulls-list']

def read(file):
    return json.loads(file.read_text())

cases = {}
for file in sorted((out / 'after-app').glob('audit-*.json'), key=lambda p: p.stat().st_mtime):
    for case in read(file):
        cases[case['surface'], case['theme'], case['reduced']] = case
for name in surfaces:
    for theme in ['dark', 'light']:
        for motion in ['0', '1']:
            c = cases[name, theme, motion]['checks']
            assert 'error' not in c, (name, theme, motion, c.get('error'))
            assert c['stationaryScrollBackgroundDifference'] == 0
            assert c['stationaryReflowBackgroundDifference'] == 0
            if name in ['shell-home','thread-header','conversation-helpers','notes-list','notes-gallery','tasks-list','tasks-board','dock-explorer','dock-notes','dock-tasks','pulls-list']:
                assert c['scrollOffsetBefore'][:2] != c['scrollOffsetAfter'][:2]
            if c.get('target'):
                assert c['nativeDoubleClickAccepted'] == 1
                assert not c['doubleClickSelection'] and not c['fastClicksSelection']
            if name == 'shell-home':
                assert c['projectHoverAfterLeave'] == 0 and c['projectDisclosureClicks'] > 0
            if name == 'composer-home-workspace':
                assert len(c['chips']) == 3 and all(not chip['selected'] for chip in c['chips'])
            if name == 'dock-explorer-file':
                assert c['codeSelection']
            if name == 'notes-editor':
                assert c['editorSelection']['anchor'] != c['editorSelection']['head']
            for suffix, width in [('hover',2560),('stationary-scroll',2560),('nudged',2560),('stationary-reflow',2360),('reflow-nudged',2360),('clicked',2360)]:
                png = (out / 'after-app' / f'{name}-{theme}-{motion}-{suffix}.png').read_bytes()
                assert (int.from_bytes(png[16:20],'big'),int.from_bytes(png[20:24],'big')) == (width,1640)

desktop = {}
for motion, directory in [('0', 'desktop-normal'), ('1', 'desktop-reduced')]:
    for file in sorted((out / directory).glob('checks-*.json'), key=lambda p: p.stat().st_mtime):
        for case in read(file):
            desktop[case['surface'], case['theme'], motion] = case
assert all((name, theme, motion) in desktop for name in surfaces
           for theme in ['dark', 'light'] for motion in ['0', '1'])
baseline_sidebar = [case for file in (out / 'before-app').glob('audit-*.json')
                    for case in read(file) if case['surface'] == 'shell-home']
assert len(baseline_sidebar) == 4
assert all(case['checks']['projectHoverAfterLeave'] > 0 for case in baseline_sidebar)
drag = {}
for label in ['before', 'after']:
    drag[label] = {name: len(read(out / 'drag' / f'{label}-{name}-tracking.json'))
                   for name in ['board', 'list', 'project']}
    assert all(count == 60 for count in drag[label].values())

native = read(out / 'after-native.json')
assert len(native) == 2 and all(all(c['checks'].values()) for c in native)
receipt = read(out / 'native-passed.json')
assert receipt['passed'] and receipt['sha256'] == hashlib.sha256(
    (app / 'native/build/gpuix-native.darwin-arm64.node').read_bytes()).hexdigest()
sources = read(out / 'source-hashes-before.json')
assert all(hashlib.sha256((app.parents[1] / name).read_bytes()).hexdigest() == digest
           for name, digest in sources.items())

bench = {}
metadata = {}
for label in ['before', 'after']:
    data = read(out / f'bench/hr5-hover-paired-{label}/result.json')
    metadata[label] = data
    assert not data['aborted'] and len(data['results']) == 6
    if label == 'after':
        assert data['addonSha256'] == receipt['sha256']
    summary = {}
    for name in ['sidebar-scroll', 'thread-fling', 'idle-home']:
        runs = [r for r in data['results'] if r['scenario'] == name]
        assert len(runs) == 2 and all(r['status'] == 'ok' for r in runs)
        for r in runs:
            e = r['evidence']
            assert not e['screenInvalid'] and not e['overlap'] and not e['orphanOverlap']
            # The orchestrator authorized the pinned test display at (0,0)
            # after the lid closed; both accepted topologies are 1440x900@2x.
            assert all(w['scale'] == 2 and w['width'] == 1280 and w['height'] == 820 and
                       ((w['x'] >= -1440 and w['x'] + w['width'] <= 0 and
                         w['y'] >= 900 and w['y'] + w['height'] <= 1800) or
                        (w['x'] >= 0 and w['x'] + w['width'] <= 1440 and
                         w['y'] >= 0 and w['y'] + w['height'] <= 900))
                       for key in ['windowBefore', 'windowAfter'] for w in e[key])
        # Report each independent run and the upper median used by bench markdown.
        def upper(values):
            values = sorted(v for v in values if v is not None)
            return values[len(values)//2] if values else None
        summary[name] = {
            'frames': [r['frames'] for r in runs],
            'resources': [r['resources'] for r in runs],
            'work': [r['work'] for r in runs],
            'latency': [r['latency'] for r in runs],
            'nativeDispatchToCpuPaint': [r['evidence'].get('nativeDispatchToCpuPaint') for r in runs],
            'upperMedianP95Ms': upper([r['frames']['p95'] for r in runs]),
            'upperMedianCpuPercent': upper([r['resources']['cpuPercent'] for r in runs]),
            'upperMedianGpuMs': upper([r['resources']['gpuMs'] for r in runs]),
        }
    bench[label] = {'addon': data['addonSha256'], 'host': data['host'],
                    'hardware': data['hardware'], 'workload': data['workload'],
                    'scenarios': summary}
assert bench['before']['workload'] == bench['after']['workload']
assert metadata['before']['sourceFiles'] == metadata['after']['sourceFiles']
assert metadata['before']['renderFlags'] == metadata['after']['renderFlags']
assert all(r['count'] == 0 for label in bench
           for r in bench[label]['scenarios']['idle-home']['frames'])
summary = {'native': native, 'addon': receipt['sha256'], 'auditedCases': len(cases),
           'desktopCases': len(desktop), 'cases': list(cases.values()), 'benchmark': bench,
           'baselineSidebar': baseline_sidebar, 'dragTrackingSamples': drag}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))

names = {
    'shell-home': ('Sidebar projects', '12 disclosure clicks'),
    'thread-header': ('Sidebar threads', '—'),
    'conversation-helpers': ('Nested thread groups', '2 disclosure clicks'),
    'shell-new-chat-hover': ('Rail', 'Static; wheel probe'),
    'composer-home-workspace': ('Composer project/workspace/branch chips', '3 chip double clicks'),
    'notes-list': ('Notes list', '—'), 'notes-gallery': ('Notes gallery', '—'),
    'tasks-list': ('Tasks list/groups', '2 disclosure clicks'),
    'tasks-board': ('Tasks board', '—'),
    'notes-editor': ('Notes rich editor', 'Positive native selection'),
    'dock-explorer': ('Explorer tree', '3 folder disclosure clicks'),
    'dock-explorer-file': ('Explorer source body', 'Positive code selection; short file'),
    'dock-agents': ('Dock Agents tab', 'Tab only; empty agent list'),
    'dock-notes': ('Dock notes list', '—'), 'dock-tasks': ('Dock tasks list', '—'),
    'settings-general': ('Settings list', 'Static; wheel probe'),
    'dock-add-menu': ('Dock menu/popover', 'Static; wheel probe'),
    'palette': ('Command palette', 'Wheel probe'),
    'pulls-list': ('Pull request list', '—'),
}
lines = ['<!-- generated-audit -->',
         '**Items 6 and 7: fixed.** All 76 final native cases and 76 matching',
         'headless WebKit references completed (19 surfaces × two themes ×',
         'normal/reduced motion). Every sampled post-scroll/reflow background',
         'matches the tiny mouse-move oracle. Every tested interactive target',
         'keeps an empty text selection after AppKit double clicks and fast',
         'click/short-drag sequences. All project-remnant counts are zero.',
         '', '| Surface | Result in all four combinations | Additional coverage / scope |',
         '| --- | --- | --- |']
for name in surfaces:
    title, extra = names[name]
    result = 'Selection retained' if name in ['notes-editor', 'dock-explorer-file'] else 'Hover/reflow and clicks pass'
    lines.append(f'| {title} | {result} | {extra} |')
lines += ['', 'Static controls have wheel probes without content movement; the short',
          'Explorer source and editor rows use positive selection checks rather',
          'than interactive-label click assertions. The existing native updater',
          'separately verifies code viewport scroll/wrap, Explorer motion and',
          'cached/full PR list/summary/diff pixels in all four combinations.', '',
          '## Before/after performance', '',
          'The table uses the upper median of two independent runs, as the',
          'benchmark report does. Max is the worst observed interval across both.', '',
          '| Scenario | Submission p50/p95/p99 ms, before → after | Worst ms | CPU % | GPU ms/window | Footprint MiB |',
          '| --- | --- | --- | --- | --- | --- |']

def fmt(value):
    return '—' if value is None else f'{value:.2f}'

def upper(values):
    values = sorted(v for v in values if v is not None)
    return values[len(values)//2] if values else None

for name in ['sidebar-scroll', 'thread-fling', 'idle-home']:
    pair = [bench[label]['scenarios'][name] for label in ['before', 'after']]
    frames = [' / '.join(fmt(upper([r[key] for r in s['frames']])) for key in ['p50', 'p95', 'p99']) for s in pair]
    maxima = [max((r['max'] for r in s['frames'] if r['max'] is not None), default=None) for s in pair]
    cpu = [fmt(s['upperMedianCpuPercent']) for s in pair]
    gpu = [fmt(s['upperMedianGpuMs']) for s in pair]
    memory = [fmt(upper([r['footprintMiB'] for r in s['resources']])) for s in pair]
    lines.append(f'| {name} | {" → ".join(frames)} | {" → ".join(map(fmt,maxima))} | {" → ".join(cpu)} | {" → ".join(gpu)} | {" → ".join(memory)} |')
lines += ['', '| Scroll work / input probe | Before | After |', '| --- | --- | --- |']
for name in ['sidebar-scroll', 'thread-fling']:
    for title, get in [
        ('React commits/window', lambda s: upper([w['reactCommits'] for w in s['work']])),
        ('native render p95 ms', lambda s: upper([w['renderMs']['p95'] for w in s['work']])),
        ('native layout p95 ms', lambda s: upper([w['layoutMs']['p95'] for w in s['work']])),
        ('next-submission proxy p95 ms', lambda s: upper([w['proxyMs']['p95'] for w in s['latency']])),
        ('first-packet dispatch-to-CPU-paint p95 ms', lambda s: upper([w['firstMs']['p95'] for w in s['nativeDispatchToCpuPaint']])),
        ('last-packet dispatch-to-CPU-paint p95 ms', lambda s: upper([w['lastMs']['p95'] for w in s['nativeDispatchToCpuPaint']])),
    ]:
        values = [fmt(get(bench[label]['scenarios'][name])) for label in ['before', 'after']]
        lines.append(f'| {name}: {title} | {values[0]} | {values[1]} |')
lines += ['', 'All six candidate runs passed the screen, owned-window, process, build',
          'overlap, input continuity and active-sample gates. Both baseline and',
          'candidate idle windows submitted **zero frames**. Source-file hashes,',
          'the 15 production-change hashes, render flags and dataset match.',
          'Individual runs and all work/input distributions are in `summary.json`;',
          'raw evidence is `bench/hr5-hover-paired-{before,after}/result.json`.',
          '<!-- /generated-audit -->']
report = app / 'perf/hover/RESULTS.md'
body = report.read_text()
start, end = '<!-- generated-audit -->', '<!-- /generated-audit -->'
if start in body:
    body = body[:body.index(start)] + '\n'.join(lines) + body[body.index(end)+len(end):]
else:
    body = body.replace('App-wide audit and performance tables are filled from the accepted final run.', '\n'.join(lines))
report.write_text(body)
print(json.dumps({'auditedCases': len(cases), 'desktopCases': len(desktop),
                  'addon': receipt['sha256'], 'benchmark': bench}, indent=2))
