import { expect, test } from 'bun:test'
import { shellExecutableLabel, terminalTabLabel } from './title.ts'

test('a console that announces its executable gets the shell’s name', () => {
  expect(shellExecutableLabel('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd')
  expect(shellExecutableLabel('Administrator: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('PowerShell')
  expect(shellExecutableLabel('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"')).toBe('PowerShell')
  expect(shellExecutableLabel('C:\\tools\\ssh.exe')).toBe('ssh')
})

test('a title the user or a program set is left alone', () => {
  expect(shellExecutableLabel('title I set')).toBeNull()
  expect(shellExecutableLabel('~/projects/kybern')).toBeNull()
  expect(shellExecutableLabel('mac@host:/srv')).toBeNull()
})

test('the tab says the machine for a terminal on another machine', () => {
  expect(terminalTabLabel('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd')
  expect(terminalTabLabel('C:\\WINDOWS\\system32\\cmd.exe', 'satyamas')).toBe('cmd · satyamas')
  expect(terminalTabLabel('cmd', 'satyamas')).toBe('cmd · satyamas')
  expect(terminalTabLabel('build', 'satyamas')).toBe('build')
  expect(terminalTabLabel('cmd')).toBe('cmd')
  expect(terminalTabLabel(undefined)).toBe('Terminal')
})
