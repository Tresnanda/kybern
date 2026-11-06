import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ContentPart, ProviderStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ComposerView } from '../Composer.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { set } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'


const at = '2026-11-02T15:27:00Z'
const thread: Thread = { id: 'native-commands', title: 'Native commands', project_id: 'fixture', provider: { kind: 'omp', instance: 'default' }, status: 'idle', provider_session_id: 'fixture-session', permission_mode: 'supervised', created_at: at, updated_at: at } as Thread
const blocks: Block[] = [
  {kind:'user',id:'input',turnId:'turn',at,seq:1,message:{parts:[{type:'text',text:'/usage'}]}},
  {kind:'assistant',id:'output',messageId:'output',segment:0,turnId:'turn',at,seq:2,origin:{kind:'root'},text:'### omp · /usage\n\n**Account usage**\n\n- Session: 12% used\n- Weekly: 38% used\n\nResets in **4 hours**.\n\n_Sample harness output for the visual check._',thinking:'',complete:true},
  {kind:'turn_end',id:'end',turnId:'turn',at,seq:3,stopReason:'completed',usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0},costUsd:null,durationMs:100,terminalMessageId:'output',error:null},
]
const providerCommands = [
  {name:'usage',description:'Show account usage'},
  {name:'handoff',description:'Compact in place with handoff instructions'},
  {name:'compact',description:'Compact context',subcommands:[{name:'soft',description:'Soft compaction'}]},
  {name:'agents',description:'List native agents'},
  {name:'model',description:'Hidden duplicate'},
  {name:'sample-skill',description:'Hidden duplicate',source:'skill'},
]
set({ status: 'open', threads: [thread], selectedId: thread.id, open: { ...emptyThreadState(), loaded: true, thread, blocks, providerCommands } })
const provider = { kind: 'omp', available: true, models: [], supported_permission_modes: ['supervised'] } as unknown as ProviderStatus

function Fixture() {
  const t = useTheme()
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <Transcript />
    <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
      <ComposerView thread={thread} draftKey="native-commands" currentThreadId="native-commands" provider={{ kind: 'omp', instance: 'default' }} providers={[provider]} accounts={[]} model="Fixture model" effort="high" mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} onSend={async () => {}} />
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Native commands', width: Number(process.env.KYBERN_LONGLINK_WIDTH ?? 1000), height: 850, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
