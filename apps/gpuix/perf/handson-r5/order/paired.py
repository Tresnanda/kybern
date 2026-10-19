"""Five cold and five warm launches per variant, in one queued quiet window."""
import hashlib, json, os, pathlib, subprocess
app=pathlib.Path(__file__).resolve().parents[3]
root=app.parents[1]
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/order')
data='/Users/mymac/projects/ade-gpuix-scratch/hr5-order-bench'
env=dict(os.environ,GPUIX_BACKGROUND='1',KYBERN_DATA_DIR=data,KYBERN_CLIENT_CONFIG_DIR=data+'/client',KYBERN_URL='',KYBERN_TOKEN='',KYBERN_BENCH_PORT='4343',KYBERN_BENCH_EVIDENCE=str(out),KYBERN_TEST_DAEMON=str(root/'target/debug/kybernd'),KYBERN_STARTUP_TRACE='1',KYBERN_BENCH_APP_ENTRY=str(app/'perf/handson-r5/order/entry.ts'))
subprocess.run(['bun','perf/handson-r5/order/baseline.ts'],cwd=app,env=env,check=True)
files=['state.ts','shell/Connection.tsx','nav/overlay.tsx','transcript/images.tsx']
digest=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
(out/'comparison-sources.json').write_text(json.dumps({
    'baselineRef':'e1ffabf63',
    'baselineModules':{file:digest(pathlib.Path('/Users/mymac/projects/ade-gpuix-scratch/hr5-order-baseline-source')/file) for file in files},
    'candidateModules':{file:digest(app/'src'/file) for file in files},
    'sameDaemonSha256':digest(root/'target/debug/kybernd'),
    'sameAddonSha256':digest(app/'native/build/gpuix-native.darwin-arm64.node'),
    'note':'The benchmark sourceFiles hashes describe the worktree. These four app modules are replaced by the baseline loader only in before-final.'
},indent=2))
for variant in ['before-final','after-final']:
    with (out/(variant+'.log')).open('w') as log:
        result=subprocess.run(['bun','perf/bench/run.ts','startup-cold','startup-warm','--runs','5','--label',variant,'--keep-data'],cwd=app,env={**env,'HR5_ORDER_BASELINE':'1' if variant.startswith('before') else '0','KYBERN_BENCH_SOURCE_LABEL':'e1ffabf63 startup/dialog/image modules' if variant.startswith('before') else 'candidate working tree'},stdout=log,stderr=subprocess.STDOUT)
    for suffix in ['json','md']:
        (out/(variant+'.'+suffix)).write_bytes((app/('perf/bench/results/'+variant+'.'+suffix)).read_bytes())
    if result.returncode:
        raise RuntimeError(variant+' failed; see its evidence log')
    doc=json.loads((out/(variant+'.json')).read_text())
    accepted=[r for r in doc['results'] if r['status']=='ok']
    assert len(accepted)==10
    if variant.startswith('after'):
        assert all(r['timings']['sidebarPaintMs']<=r['timings']['firstContentMs'] for r in accepted)
    print(variant+': ten accepted launches',flush=True)
