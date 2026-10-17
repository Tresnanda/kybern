/**
 * Editor lane fixtures: one note holding every block the editor draws, with a live
 * task reference to a seeded task. Only ever touches the scratch daemon.
 */
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SAMPLES } from '../src/editor/samples.ts'
import { SAMPLE_FILE } from './screens/editor9-reset.mjs'

export const EDITOR_NOTE = 'Editor sample'

export async function seed(client: KybernClient) {
  const tasks = (await client.call('tasks.items.list', {})).tasks
  const task = tasks.find(t => t.title === 'Ship notes image blocks') ?? tasks[0]!
  const body = SAMPLES.all!.replace('[ADE-14](kybern://task/11111111-1111-4111-8111-111111111111)', `[${task.key}](kybern://task/${task.id})`)
  await client.call('notes.create', { scope: 'global', project_id: null, title: EDITOR_NOTE, body })
  mkdirSync(path.dirname(SAMPLE_FILE), { recursive: true })
  writeFileSync(SAMPLE_FILE, JSON.stringify({ title: EDITOR_NOTE, body }))
}
