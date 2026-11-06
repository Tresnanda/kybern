import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCommandSpecs } from '../src/nativeCommands.ts';
const command = (name, extra = {}) => ({name, description: name, ...extra});
test('native menus hide duplicated controls and skills, preserve invocation and compact subcommands', () => {
  const result = nativeCommandSpecs(['usage','agents','reconnect','model','stats','browser','handoff'].map(name=>command(name)).concat([command('skill', {source:'skill'}), command('compact', {subcommands:[command('soft')]})]), 'omp');
  assert.deepEqual(result.map(c=>[c.name,c.invocation]), [['harness:usage','usage'],['harness:agents','agents'],['harness:reconnect','reconnect'],['handoff','handoff'],['omp:compact','compact']]);
  assert.deepEqual(nativeCommandSpecs([command('compact'),command('browser'),command('schedule')], 'antigravity'), []);
});
