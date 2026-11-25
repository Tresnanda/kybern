import { expect, test } from 'bun:test'
import { goneCopyCopy } from './goneCopy.ts'

test('names the machine, or this computer', () => {
  expect(goneCopyCopy({ machineName: 'kdi-vps', isLocal: false }).title).toBe('Folder is gone on kdi-vps')
  expect(goneCopyCopy({ machineName: 'Mac', isLocal: true }).title).toBe('Folder is gone on this computer')
})
