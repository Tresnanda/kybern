import assert from 'node:assert/strict';
import test from 'node:test';
import { skillSourceLabel, uniqueSkills } from '../src/skillSources.ts';

const skill = (name, scope, extra = {}) => ({ name, scope, path: `/${scope}/${name}/SKILL.md`, enabled: true, ...extra });

test('a plugin skill says Plugin, and a standalone copy of one says both', () => {
  assert.equal(skillSourceLabel(skill('interfaces:better-colors', 'app', { plugin: 'interfaces' })), 'Plugin');
  assert.equal(skillSourceLabel(skill('better-colors', 'user', { plugin: 'interfaces' })), 'Plugin · Personal');
  assert.equal(skillSourceLabel(skill('better-colors', 'project', { plugin: 'interfaces' })), 'Plugin · Project');
});

test('skills without a plugin keep their own labels', () => {
  const labels = ['project', 'repo', 'user', 'app', 'plugin', 'system', 'admin', 'other'].map((scope) => skillSourceLabel(skill('x', scope)));
  assert.deepEqual(labels, ['Project', 'Repo', 'Personal', 'App', 'Plugin', 'System', 'System', 'Provider']);
});

test('an older daemon\'s repeated plugin skills collapse to one row each', () => {
  const rows = uniqueSkills([
    skill('interfaces:better-accessibility', 'app'),
    skill('interfaces:better-accessibility', 'app'),
    skill('Interfaces:Better-Accessibility', 'app'),
    skill('better-accessibility', 'user'),
    skill('better-accessibility', 'user', { home: 'agents' }),
  ]);
  assert.deepEqual(rows.map((row) => [row.name, row.scope, row.home ?? null]), [
    ['interfaces:better-accessibility', 'app', null],
    ['better-accessibility', 'user', null],
    ['better-accessibility', 'user', 'agents'],
  ]);
});
