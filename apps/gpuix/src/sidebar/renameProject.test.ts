import { expect, test } from 'bun:test'
import { renamedProject } from '../../../../packages/kybern-client/src/projectName.ts'
import { renamingProjectId, startProjectRename, stopProjectRename } from './renameProject.ts'

test('an empty or unchanged name cancels the rename; others are trimmed', () => {
  expect(renamedProject('   ', 'ade')).toBeNull()
  expect(renamedProject(' ade ', 'ade')).toBeNull()
  expect(renamedProject('  Kybern  ', 'ade')).toBe('Kybern')
})

test('only the row being edited can end its rename', () => {
  startProjectRename('a')
  stopProjectRename('b')
  expect(renamingProjectId()).toBe('a')
  stopProjectRename('a')
  expect(renamingProjectId()).toBeNull()
})
