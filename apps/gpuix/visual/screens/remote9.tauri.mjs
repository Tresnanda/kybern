// remote9: SSH setup states in the desktop frontend (WebKit). `remote_bootstrap` is mocked with the progress events
// and error strings remote.rs emits for the same machines as `remote9-ssh.sh`.
const park = p => p.mouse.move(1275, 815)
const PERM = 'SSH could not sign in to dev@perm.example without a password. Copy your key there with `ssh-copy-id dev@perm.example` or load it in ssh-agent, then try again'
const CLOSED = 'Unable to reach dev@closed.example over SSH. Check that the machine is on and its SSH port is open'
async function prepare(p) {
  await p.evaluate(async ({ PERM, CLOSED }) => {
    let handler = null
    const emit = (step, state, detail) => handler?.({ event: 'remote-bootstrap', id: 1, payload: { step, state, ...(detail ? { detail } : {}) } })
    // `listen()`'s unlisten goes through the event plugin's own global.
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { handler = callback; return 1 },
      invoke: async (command, args) => {
        if (command === 'remote_ssh_hosts') return []
        if (command === 'plugin:event|listen') return 1
        if (command !== 'remote_bootstrap') return null
        const target = args.input.target
        emit('connect', 'running')
        if (target.includes('perm.') || target.includes('closed.')) { const message = target.includes('perm.') ? PERM : CLOSED; emit('failed', 'failed', message); throw message }
        emit('connect', 'done', 'Linux x86_64'); emit('install', 'running'); emit('install', 'done', 'kybernd 0.9.1 is installed'); emit('start', 'running')
        return new Promise(() => {})
      },
    }
    const { useEnvironments } = await import('/src/state/environments.ts')
    const url = new URL(location.href).searchParams.get('url')
    useEnvironments.setState({ profiles: [{ id: 'local', name: 'Development environment', local: false, url }], selectedId: 'local' })
  }, { PERM, CLOSED })
}
const setup = (machine, ready) => async p => {
  await prepare(p)
  await p.getByRole('button', { name: 'Switch environment', exact: true }).click()
  await p.getByRole('menuitem', { name: 'Add environment', exact: true }).click()
  await p.getByRole('textbox', { name: 'Name' }).fill('Dev server'); await p.getByLabel('SSH machine').fill(machine)
  await p.getByRole('button', { name: 'Set up and connect' }).click()
  await ready(p); await p.waitForTimeout(400); await park(p)
}
export const screens = {
  'r9-ssh-progress': setup('dev@slow.example', p => p.getByText('kybernd 0.9.1 is installed').waitFor()),
  'r9-ssh-permission': setup('dev@perm.example', p => p.locator('p[role=alert]').waitFor()),
  'r9-ssh-unreachable': setup('dev@closed.example', p => p.locator('p[role=alert]').waitFor()),
}
