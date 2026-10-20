import os,pathlib,subprocess,json
root=pathlib.Path(__file__).resolve().parents[4]; app=root/'apps/gpuix'; out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2')
rows=[]
for count in (1000,3000):
 for sparse in (False,True):
  env=dict(os.environ,TRANSCRIPT_HEADLESS='1',TRANSCRIPT_TURNS=str(count),KYBERN_SPARSE_LIST='1' if sparse else '0',KYBERN_DATA_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2',KYBERN_CLIENT_CONFIG_DIR='/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2',KYBERN_URL='',KYBERN_TOKEN='')
  child=subprocess.run(['bun','perf/transcript/fixture.tsx'],cwd=app,env=env,capture_output=True,text=True,timeout=90)
  (out/f'counts-{count}-{int(sparse)}.log').write_text(child.stdout+child.stderr)
  if child.returncode:raise RuntimeError(child.stderr)
  value=json.loads(child.stdout.strip().splitlines()[-1]);value['sparse']=sparse;rows.append(value)
(out/'counts.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows,indent=2))
