import type { Register } from 'claude-code'

// Built-in tools whose full description is sent with every request unless they
// wait behind ToolSearch. Claude loads one when a turn needs it (`select:Artifact`).
const ON_DEMAND = new Set([
  'Artifact',
  'ArtifactData',
  'ArtifactComments',
  'Workflow',
  'ScheduleWakeup',
  'ReportFindings',
  'ListAgents',
])

export const register: Register = (on) => {
  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    return ON_DEMAND.has(e.tool) ? { ...result, isDeferred: true } : result
  })
}
