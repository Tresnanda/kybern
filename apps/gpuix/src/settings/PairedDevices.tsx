// Settings › Paired devices: phones and other devices that can see and drive every machine from one pairing. The pairing
// dialog and the list live in `environments/Dialogs.tsx`; this page is where they open from now that the environment
// menu is gone.
import { useApp } from '../state.ts'
import { Row, Section } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'

export function PairedDevices() {
  const connected = useApp((s) => s.status === 'open')
  return <Section title="Paired devices">
    <Row title="Pair a device" description="Give a phone access to this machine. When it is in your network, the phone reaches your other machines through it too. You can remove it here at any time."><Button testId="paired-devices-open" variant="primary" disabled={!connected} onClick={() => showEnvironmentDialog({ kind: 'pair' })}>Pair a device</Button></Row>
  </Section>
}
