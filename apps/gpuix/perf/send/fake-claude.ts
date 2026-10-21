#!/usr/bin/env bun
// A stand-in `claude` CLI for send-latency measurements: it speaks just enough of Claude Code's stream-json protocol
// (initialize, user turns, interrupt) and answers each prompt after FAKE_CLAUDE_TURN_MS. FAKE_CLAUDE_START_MS delays
// the first output, like a slow session resume. Never contacts a model.
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('2.1.99 (Claude Code)'); process.exit(0) }
if (args.includes('-p')) { process.exit(0) }
const sessionArg = args.find(a => a.startsWith('--session-id=') || a.startsWith('--resume='))
const session = sessionArg?.split('=')[1] ?? crypto.randomUUID()
const turnMs = Number(process.env.FAKE_CLAUDE_TURN_MS ?? 1500)
await Bun.sleep(Number(process.env.FAKE_CLAUDE_START_MS ?? 0))
const write = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n')
let turn: ReturnType<typeof setTimeout> | undefined
let bound = false
const reply = (prompt: string) => {
  if (!bound) { bound = true; write({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake' }) }
  write({ type: 'system', subtype: 'status', status: 'requesting' })
  clearTimeout(turn)
  turn = setTimeout(() => {
    const id = `msg_${crypto.randomUUID()}`
    write({ type: 'assistant', uuid: crypto.randomUUID(), session_id: session, parent_tool_use_id: null, message: { id, role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: `Done: ${prompt.slice(0, 60)}` }], usage: { input_tokens: 10, output_tokens: 5 } } })
    write({ type: 'result', subtype: 'success', session_id: session, duration_ms: turnMs, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 }, is_error: false })
  }, turnMs)
}
let buffer = ''
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') {
      if (frame.request?.subtype === 'interrupt') clearTimeout(turn)
      write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], models: [] } } })
    } else if (frame.type === 'user') {
      const content = frame.message?.content
      reply(typeof content === 'string' ? content : (content ?? []).map((b: { text?: string }) => b.text ?? '').join(' '))
    }
  }
}
