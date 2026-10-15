import {launchFixture} from './harness.ts'
const f = await launchFixture('', {GPUIX_BACKGROUND:'1', KYBERN_GPUIX_NOTIFICATION_TEST:'1', KYBERN_GPUIX_THREAD:''})
try {
 console.log('Notification test PID:', f.pid)
 for(let i=0;i<18;i++) {await Bun.sleep(5000); if(f.diagnostics().includes('[notification click]')) break}
 console.log(f.diagnostics())
} finally {await f.close()}
