import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginRows, pluginCopyRequest, contentsText, jobText} from '../src/pluginSync.ts';
const plugin = (extra = {}) => ({id:'review@tools', provider:'claude-code', kind:'plugin', name:'Review', marketplace:'tools', source:'acme/tools', version:'1', enabled:true, resources:{}, contents:{hooks:2,mcp_servers:1,commands:0,agents:0,skills:3,extensions:0,npm_packages:[],notes:[]}, problem:null,fingerprint:'a', ...extra});
const machine=(id,plugins=[],state='reported')=>({id,name:id,is_self:id==='a',state,inventory:state==='reported'?{plugins,warnings:[],jobs:[]}:null,detail:null});
test('missing is not offline or unreadable, and differences include enabled state',()=>{
 const view={machines:[machine('a',[plugin()]),machine('b',[plugin({enabled:false,fingerprint:'b'})]),machine('c'),machine('offline',[],'offline')]};
 const [r]=pluginRows(view);assert.equal(r.different,true);assert.equal(r.missing,true);assert.deepEqual(r.cells.map(c=>c.state),['same','different','missing','unknown']);
 assert.equal(pluginRows(view,'claude','different').length,1);assert.equal(pluginRows(view,'nope').length,0);
 view.machines[2].inventory.warnings.push('claude-code: unreadable');assert.equal(pluginRows(view)[0].cells[2].state,'unknown');
});
test('confirmation binds source and only explicitly reviewed replacement',()=>{
 const a=machine('a',[plugin()]),b=machine('b',[plugin({fingerprint:'b'})]);const view={machines:[a,b]};
 assert.deepEqual(pluginCopyRequest(a,plugin(),[b],view,false),{provider:'claude-code',id:'review@tools',from:null,to:[{machine:'b',replaces:null}],confirmed:'a'});
 assert.equal(pluginCopyRequest(a,plugin(),[b],view,true).to[0].replaces,'b');
});
test('same names in different harnesses stay separate and bulk copy does not invent support',()=>{
 const view={machines:[machine('a',[plugin(),plugin({provider:'cursor',enabled:null,problem:'Manual installation required'})]),machine('b')]};assert.equal(pluginRows(view).length,2);assert.equal(pluginRows(view)[1].plugin.problem,'Manual installation required');
});
test('contents and queued failures stay visible',()=>{
 assert.equal(contentsText(plugin()),'2 hooks · 1 MCP server · 3 skills');assert.match(jobText({state:'queued',result:null,error:null}),/Queued/);
 assert.equal(jobText({state:'delivered',result:{state:'failed',message:'Harness rejected package'},error:null}),'Harness rejected package');
});
