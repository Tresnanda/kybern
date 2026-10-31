import {expect,test} from 'bun:test'
import {githubRepo,githubPull,resolvePull,matchingPulls} from './tabTargets.ts'
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
