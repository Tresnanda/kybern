"""Collect validated hidden-display image pairs without rewriting other lanes."""
import json
import os
from pathlib import Path

out = Path(os.environ.get('KYBERN_MEMORY_EVIDENCE', '/Users/mymac/projects/ade/previews/gpuix/perf/images'))
names = ['before-note', 'control-legacy-note', 'control-owner-note', 'after-note',
         'before-lab', 'after-lab', 'before-thread-app', 'after-thread-app']
summary = {}
for name in names:
    folder = out / name
    rows = json.loads((folder / 'results.json').read_text())
    reduced = []
    for row in rows:
        gate = row['gate']
        assert not any(gate[key] for key in ['overlap', 'orphanOverlap', 'screenInvalid']), (name, row['name'], gate)
        for key in ['testDisplayBefore', 'testDisplayAfter']:
            assert 'testActive=true testScale=2.0' in row[key], (name, row['name'], key)
        native = row['attribution'].get('native', {})
        reduced.append({key: row.get(key) for key in ['name', 'resources', 'frames', 'proxy', 'nativeInput', 'work', 'sceneSubmissionProxyMs', 'sceneSubmissionSamples']} | {
            'native': native,
            'testDisplayBefore': row['testDisplayBefore'], 'testDisplayAfter': row['testDisplayAfter'],
        })
    summary[name] = {'metadata': json.loads((folder / 'metadata.json').read_text()), 'rows': reduced}
(out / 'paired-summary.json').write_text(json.dumps(summary, indent=2))
for name, data in summary.items():
    print(name)
    initial = data['rows'][0]['resources']['footprintMiB']
    for row in data['rows']:
        r = row['resources']
        print(row['name'], 'MiB', r['footprintMiB'], 'delta', r['footprintMiB'] - initial,
              'CPU', r['cpuPercent'], 'GPU ms', r['gpuMs'], 'frames', row['frames'],
              'scene latency', row['sceneSubmissionProxyMs'])
