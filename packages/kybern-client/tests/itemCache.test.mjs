import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemCache, mergeOfflineItems } from '../src/itemCache.ts';
import { memoryTranscriptCacheStore } from '../src/transcriptCache.ts';
test('item cache persists note bodies and wipes removed owners', async () => {
  const store = memoryTranscriptCacheStore();
  const cache = new ItemCache(store);
  await cache.put('a', 'notes.get', { id: 'x' }, { note: { id: 'x', body: 'Readable offline' } });
  const restarted = new ItemCache(store);
  assert.equal((await restarted.read('a', 'notes.get', { id: 'x' })).note.body, 'Readable offline');
  await restarted.removeMachine('a');
  assert.equal(await restarted.read('a', 'notes.get', { id: 'x' }), undefined);
});
test('offline merges preserve owners and label cached content', () => {
  const previous = { tasks: [{ id: 't' }], federation: { sections: [{ machine_id: 'b', ids: ['t'] }] } };
  const current = { tasks: [], federation: { sections: [], skipped: [{ machine_id: 'b', machine_name: 'Laptop', reason: 'offline' }] } };
  const merged = mergeOfflineItems(current, previous, 'tasks.items.list');
  assert.deepEqual(merged.tasks, [{ id: 't' }]);
  assert.equal(merged.federation.sections[0].stale, true);
  assert.match(merged.federation.footer, /cached tasks/);
  current.federation.skipped[0].reason = 'refused';
  assert.deepEqual(mergeOfflineItems(current, previous, 'tasks.items.list').tasks, []);
});
test('federated cache partitions rows by owner for a different answering member', async () => {
  const cache = new ItemCache();
  await cache.put('a', 'tasks.items.list', { machine: 'all' }, {
    tasks: [{ id: 'x', key: 'TASK-1', body: 'Owned by b' }],
    federation: { sections: [{ machine_id: 'b', ids: ['x'] }] }
  });
  assert.equal((await cache.read('b', 'tasks.items.get', { id: 'x' })).task.body, 'Owned by b');
  await cache.removeMachine('b');
  assert.equal(await cache.read('b', 'tasks.items.get', { id: 'x' }), undefined);
  assert.deepEqual((await cache.read('a', 'tasks.items.list', { machine: 'all' })).tasks, []);
});


test('failed edits keep recoverable text in the outbox model', async () => {
  const { outboxRows } = await import('../src/networkSettings.ts');
  const rows = outboxRows([{ id: 'queued', kind: 'item_edit', target: 'b', state: 'failed', payload: {
    params: { id: 'n', expected_revision: 3, title: 'My note', body: 'Keep my edit' }
  }, last_error: 'Compare the owner version and save again.' }], new Map([['b', 'Laptop']]));
  assert.equal(rows[0].editText, 'Title: My note\n\nKeep my edit');
  assert.match(rows[0].detail, /Compare the owner version/);
});
