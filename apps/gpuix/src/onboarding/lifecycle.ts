// What ties the first run to the connection it runs on. Imported by `Welcome.tsx`, which is always mounted.
//
// - A different environment (Connect to another machine, a saved one) is a different first run: its own completion mark, its own
//   scene, its own scan and detection. Every module store that holds a client or a result of the last machine starts over.
// - However the flow ends (Set up later, a free chat, Start building), a scan that is still running stops: nothing reads it now.
import { onEnvironmentChange } from '../shell/environment.ts'
import { resetAgents } from './agentsStore.ts'
import { flow, resetFlow } from './flow.ts'
import { cancelScan, resetProjects } from './projectsStore.ts'

/** Everything the first run keeps in module stores, back to a fresh install's. */
export function resetOnboarding() {
  resetFlow()
  resetProjects()
  resetAgents()
}
onEnvironmentChange(resetOnboarding)

flow.subscribe(() => {
  const { releasing, finished } = flow.get()
  if (releasing || finished) cancelScan()
})
