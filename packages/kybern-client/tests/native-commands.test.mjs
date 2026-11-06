import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCommandSpecs } from '../src/nativeCommands.ts';
const command = (name, extra = {}) => ({name, description: name, ...extra});
test('native menus hide duplicated controls and skills, preserve invocation and compact subcommands', () => {
  const result = nativeCommandSpecs(['usage','agents','reconnect','model','stats','browser','handoff'].map(name=>command(name)).concat([command('skill', {source:'skill'}), command('compact', {subcommands:[command('soft')]})]), 'omp');
  assert.deepEqual(result.map(c=>[c.name,c.invocation,c.label]), [['omp:usage','usage','Usage'],['omp:agents','agents','Agents'],['omp:reconnect','reconnect','Reconnect'],['handoff','handoff','Handoff'],['omp:compact','compact','Compact']]);
  assert.deepEqual(nativeCommandSpecs([command('compact'),command('browser'),command('schedule')], 'antigravity'), []);
});
test('each harness owns its collision prefix and labels use the original command in sentence case', () => {
  for (const [provider, prefix] of [['codex', 'codex'], ['claude-code', 'claude'], ['pi', 'pi'], ['opencode', 'opencode'], ['cursor', 'cursor'], ['antigravity', 'agy'], ['grok-build', 'grok']]) {
    const [usage, review] = nativeCommandSpecs([command('usage'), command('review_changes')], provider);
    assert.equal(usage.name, `${prefix}:usage`);
    assert.equal(usage.label, 'Usage');
    assert.equal(usage.invocation, 'usage');
    assert.equal(review.label, 'Review changes');
  }
});
