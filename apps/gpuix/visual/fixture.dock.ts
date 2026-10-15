import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import type { SeedContext } from './load.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function seed(client: KybernClient, { projects }: SeedContext) {
  const root = projects[0]!.path!
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src/dock-example.ts'), 'export const example = 1;\nexport const next = 2;\n')
  writeFileSync(path.join(root, 'preview.html'), '<!doctype html><title>Dock preview</title><h1>Workspace preview</h1><p>A local fixture.</p>')
  await client.call('notes.create', { scope: 'project', project_id: projects[1]!.id, project_role: 'brief', title: 'Project brief', body: 'Build a clear documentation site for Kybern.' })
  // A brief suppresses the setup interview, so this creates no agent turn.
  await client.call('coordinator.open', { project_id: projects[1]!.id, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
  await client.call('threads.create', {
    project_id: projects[0]!.id,
    title: 'Dock visual review',
    provider: { kind: 'claude-code', instance: 'default' },
    model: 'claude-haiku-5-5',
  })
}

export async function ids(client: KybernClient) {
  const { threads } = await client.call('threads.list', {})
  return { thread: threads.find(t => t.title === 'Dock visual review')!.id, coordinator: threads.find(t => t.coordinator_project_id)!.id }
}
