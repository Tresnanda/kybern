import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyLink, markdownLinks, linkStateColor } from '../src/linkIcons.ts'
test('reply link classification preserves labels and separates GitHub targets', () => {
  assert.equal(classifyLink('https://github.com/a/b/issues/275#issuecomment-1').kind, 'issue')
  assert.equal(classifyLink('https://github.com/a/b/pull/278/files').kind, 'pull')
  for (const path of ['a/b', 'a/b/commit/abc', 'a/b/actions/runs/1']) assert.equal(classifyLink('https://github.com/' + path).kind, 'github')
  assert.equal(classifyLink('https://github.com.evil.test/a/b/issues/1').kind, 'web')
  assert.equal(classifyLink('./report.md').kind, 'file')
  assert.equal(classifyLink('file:///tmp/report.pdf').kind, 'file')
  assert.equal(classifyLink('javascript:alert(1)').kind, 'none')
  assert.deepEqual(markdownLinks('[#277](https://github.com/a/b/issues/277)'), ['https://github.com/a/b/issues/277'])
  assert.equal(linkStateColor('draft'), '#848d97')
})
