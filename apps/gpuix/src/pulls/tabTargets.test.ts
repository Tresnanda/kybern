import {expect,test} from 'bun:test'
import {githubRepo,githubPull,githubActions,resolveActions,resolvePull,matchingPulls} from './tabTargets.ts'
import type {Project,PullRequest} from '../../../../packages/kybern-client/src/types.ts'
test('GitHub URLs resolve only registered repository targets, including grouped and remote-only projects',()=>{
 const known=[{projectId:'group',repo:'api',remote:'acme/api'},{projectId:'group',repo:'docs',remote:'acme/docs'},{projectId:'remote-only',remote:'acme/other'}]
 expect(resolvePull('https://github.com/acme/API/pull/108/files',known)).toEqual({projectId:'group',repo:'api',number:108})
 expect(resolvePull('https://github.com/acme/docs/pull/108#discussion',known)).toEqual({projectId:'group',repo:'docs',number:108})
 expect(resolvePull('https://github.com/acme/other/pull/789',known)).toEqual({projectId:'remote-only',number:789})
 expect(resolvePull('https://github.com/unregistered/repo/pull/1',known)).toBeNull()
 for(const url of ['https://github.com.evil/acme/api/pull/1','https://github.com/acme/api/pull/0','https://github.com/acme/api/pull/1evil','http://github.com/acme/api/pull/1'])expect(githubPull(url)).toBeNull()
})
test('remote identity accepts normalized, HTTPS and SSH GitHub remotes',()=>{
 for(const url of ['github.com/Acme/API','https://github.com/Acme/API.git','git@github.com:Acme/API.git','ssh://git@github.com/Acme/API.git'])expect(githubRepo(url)).toBe('acme/api')
 expect(githubRepo('https://elsewhere.com/acme/api')).toBeNull()
})
test('search covers known project names, grouped member names, numbers, titles and branches',()=>{
 const rows=[{project:{id:'foreign',name:'Another Space'} as Project,pr:{number:108,repo:'api',title:'Ship SSO',head:'auth/login'} as PullRequest}]
 for(const query of ['Another Space','api','#108','SSO','auth/login'])expect(matchingPulls(rows,query)).toEqual(rows)
 expect(matchingPulls(rows,'absent')).toEqual([])
})
test('Actions links name a run, a job, an attempt or a check run, ignoring query strings and fragments',()=>{
 const base='https://github.com/Acme/API'
 expect(githubActions(`${base}/actions/runs/123`)).toEqual({remote:'acme/api',runId:123})
 expect(githubActions(`${base}/actions/runs/123/`)).toEqual({remote:'acme/api',runId:123})
 expect(githubActions(`${base}/actions/runs/123/job/456`)).toEqual({remote:'acme/api',runId:123,jobId:456})
 expect(githubActions(`${base}/actions/runs/123/attempts/2`)).toEqual({remote:'acme/api',runId:123,attempt:2})
 expect(githubActions(`${base}/actions/runs/123/attempts/2/job/456`)).toEqual({remote:'acme/api',runId:123,jobId:456,attempt:2})
 expect(githubActions(`${base}/actions/runs/123/job/456?pr=7#step:3:1`)).toEqual({remote:'acme/api',runId:123,jobId:456})
 expect(githubActions(`${base}/actions/runs/123?check_suite_focus=true`)).toEqual({remote:'acme/api',runId:123})
 expect(githubActions(`  ${base}/runs/789  `)).toEqual({remote:'acme/api',jobId:789})
 expect(githubActions(`${base}/runs/789?check_suite_focus=true`)).toEqual({remote:'acme/api',jobId:789})
})
test('only GitHub Actions run, job and check-run links parse as Actions links',()=>{
 for(const url of [
  'https://github.com/acme/api/pull/5','https://github.com/acme/api/actions','https://github.com/acme/api/actions/runs','https://github.com/acme/api/actions/workflows/ci.yml',
  'https://github.com/acme/api/actions/runs/0','https://github.com/acme/api/actions/runs/12x','https://github.com/acme/api/actions/runs/123/job/0','https://github.com/acme/api/actions/runs/123/job/abc',
  'https://github.com/acme/api/actions/runs/123/attempts/0','https://github.com/acme/api/actions/runs/123/workflow','https://github.com/acme/api/runs/0','https://github.com/acme/api/runs/9/extra',
  'https://app.codecov.io/gh/acme/api/commit/abc','https://vercel.com/acme/api/deployments/1','http://github.com/acme/api/actions/runs/1','https://github.com.evil/acme/api/actions/runs/1',
  'https://github.com/acme/api/actions/runs/99999999999999999999'])expect(githubActions(url)).toBeNull()
})
test('Actions links open only for registered repositories, in their group member',()=>{
 const known=[{projectId:'group',repo:'api',remote:'acme/api'},{projectId:'solo',remote:'acme/solo'}]
 expect(resolveActions('https://github.com/acme/api/actions/runs/1/job/2',known)).toEqual({projectId:'group',repo:'api',runId:1,jobId:2})
 expect(resolveActions('https://github.com/acme/SOLO/actions/runs/3',known)).toEqual({projectId:'solo',runId:3})
 expect(resolveActions('https://github.com/acme/solo/runs/4',known)).toEqual({projectId:'solo',jobId:4})
 expect(resolveActions('https://github.com/stranger/repo/actions/runs/3',known)).toBeNull()
 expect(resolveActions('https://github.com/acme/solo/pull/3',known)).toBeNull()
})
