/**
 * Terminal scenarios shared by `verify-tui.ts` (GPUIX) and `verify-tui-desktop.mjs` (xterm.js
 * in WebKit): raw bytes sent to the pty with `terminals.input`, then a screenshot.
 */
export type Step = string | { wait: number }
export interface Scenario { name: string; steps: Step[]; /** Extra captures taken after these steps, with the steps that lead to each. */ then?: { label: string; steps: Step[] }[] }
export const DATA: Scenario[] = [
  { name: 'colors', steps: ['clear\r', { wait: 300 }, 'bash tui/colors.sh\r', { wait: 1200 }] },
  { name: 'long', steps: ['bash tui/long.sh\r', { wait: 900 }] },
  { name: 'scroll', steps: ['bash tui/scroll.sh\r', { wait: 1200 }] },
  { name: 'vim', steps: ['clear\r', 'vim -u NONE tui/unicode.txt\r', { wait: 1500 }, ':set nu\r', { wait: 500 }], then: [{ label: '-visual', steps: ['Vj', { wait: 400 }] }, { label: '-quit', steps: ['\x1b', ':q!\r', { wait: 600 }] }] },
  { name: 'less', steps: ['clear\r', 'less tui/scroll.sh\r', { wait: 1000 }, ' ', { wait: 500 }], then: [{ label: '-quit', steps: ['q', { wait: 500 }] }] },
  { name: 'wide', steps: ['clear; printf \'漢字かな ★ 🙂🙂 e\\xcc\\x81 |end|\\n12345678901234567890\\n\'\r', { wait: 900 }] },
  { name: 'top', steps: ['clear\r', 'top -l 1 -n 8 -stats pid,command,cpu,mem\r', { wait: 3000 }] },
  { name: 'tmux', steps: ['clear\r', 'tmux -L dock9 new -s dock9 \; split-window -h\r', { wait: 1500 }], then: [{ label: '-exit', steps: ['exit\r', { wait: 400 }, 'exit\r', { wait: 800 }] }] },
]
