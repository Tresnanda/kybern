import { describe, expect, test } from 'bun:test'
import { clampRows, commandNames, commandRows, gutterOf, shellTokens, splitShell } from './shell.ts'

const texts = (command: string) => splitShell(command).map((s) => s.text)
const ops = (command: string) => splitShell(command).map((s) => s.op)

describe('splitShell', () => {
  test('a chain keeps every command, never only the first', () => {
    expect(splitShell('pnpm run typecheck && bun test src')).toEqual([
      { op: null, text: 'pnpm run typecheck' },
      { op: '&&', text: 'bun test src' },
    ])
  })
  test('splits on && || ; | and |& with the operator on the segment it joins', () => {
    expect(texts('a && b || c; d | e |& f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(ops('a && b || c; d | e |& f')).toEqual([null, '&&', '||', ';', '|', '|&'])
  })
  test('quotes hide operators', () => {
    expect(texts(`echo "a && b" 'c; d' && ls`)).toEqual([`echo "a && b" 'c; d'`, 'ls'])
    expect(texts(`rg -n "ApprovalDetail|clampLines" src`)).toEqual([`rg -n "ApprovalDetail|clampLines" src`])
    expect(texts(`echo 'it\\'s' && x`).length).toBeGreaterThan(0)
  })
  test('an escaped operator is part of the word', () => {
    expect(texts(String.raw`echo a\;b && c`)).toEqual([String.raw`echo a\;b`, 'c'])
    expect(texts('echo a \\| b')).toEqual(['echo a \\| b'])
  })
  test('redirections keep their ampersand', () => {
    expect(texts('bun test 2>&1 | tee out.log')).toEqual(['bun test 2>&1', 'tee out.log'])
    expect(texts('cmd &> out && next')).toEqual(['cmd &> out', 'next'])
    expect(texts('cmd <&3')).toEqual(['cmd <&3'])
  })
  test('a single & is a background operator', () => {
    expect(ops('server & client')).toEqual([null, '&'])
  })
  test('subshells, command substitution and backticks are not split', () => {
    expect(texts('echo $(a && b) && c')).toEqual(['echo $(a && b)', 'c'])
    expect(texts('(cd x && ls) && pwd')).toEqual(['(cd x && ls)', 'pwd'])
    expect(texts('echo `a; b` ; c')).toEqual(['echo `a; b`', 'c'])
    expect(texts('echo ${A:-b;c} && d')).toEqual(['echo ${A:-b;c}', 'd'])
  })
  test('newlines separate commands, and a trailing operator continues onto the next line', () => {
    expect(texts('a\nb\n\nc')).toEqual(['a', 'b', 'c'])
    expect(ops('a\nb')).toEqual([null, '\n'])
    expect(splitShell('a &&\n  b')).toEqual([{ op: null, text: 'a' }, { op: '&&', text: 'b' }])
    expect(texts('a \\\n  --flag b')).toEqual(['a --flag b'])
  })
  test('comments hide operators', () => {
    expect(texts('ls # a && b\npwd')).toEqual(['ls # a && b', 'pwd'])
  })
  test('a heredoc body stays with its command', () => {
    const command = "cat <<'EOF' > out.txt\nline one && two\n; three\nEOF\necho done"
    const segments = splitShell(command)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.text).toBe("cat <<'EOF' > out.txt\nline one && two\n; three\nEOF")
    expect(segments[1]).toEqual({ op: '\n', text: 'echo done' })
  })
  test('<<- strips leading tabs from the delimiter line and a heredoc with no delimiter keeps the rest', () => {
    expect(texts('cat <<-X\n\tbody\n\tX\nnext')).toEqual(['cat <<-X\n\tbody\n\tX', 'next'])
    expect(texts('cat <<EOF\nstill body && x')).toEqual(['cat <<EOF\nstill body && x'])
    expect(texts('cat <<< "a && b"')).toEqual(['cat <<< "a && b"'])
  })
  test('empty and blank commands give nothing; a trailing ; drops', () => {
    expect(splitShell('')).toEqual([])
    expect(splitShell('  \n  ')).toEqual([])
    expect(texts('a;')).toEqual(['a'])
    expect(texts('a;\n')).toEqual(['a'])
  })
  test('a stray or dangling operator is not a plain chain: the command stays whole', () => {
    expect(splitShell('&& a')).toEqual([{ op: null, text: '&& a' }])
    expect(splitShell('  \n ; ')).toEqual([{ op: null, text: ';' }])
    expect(texts('a; ; b')).toEqual(['a; ; b'])
    expect(texts('a &&')).toEqual(['a &&'])
    expect(texts('a |')).toEqual(['a |'])
    expect(texts('a\n&& b')).toEqual(['a\n&& b'])
  })
  test('a trailing background & stays on its command', () => {
    expect(splitShell('pnpm dev &')).toEqual([{ op: null, text: 'pnpm dev &' }])
    expect(texts('a && server &')).toEqual(['a', 'server &'])
  })
  test('escaped quotes do not end a string', () => {
    expect(texts(String.raw`echo "a \" && b" && c`)).toEqual([String.raw`echo "a \" && b"`, 'c'])
    expect(texts(String.raw`echo 'a'\''; b' && c`)).toEqual([String.raw`echo 'a'\''; b'`, 'c'])
    expect(texts(String.raw`echo \' && c`)).toEqual([String.raw`echo \'`, 'c'])
  })
  test('substitutions nest inside double quotes and each other', () => {
    expect(texts('echo "$(echo "a; b")" && c')).toEqual(['echo "$(echo "a; b")"', 'c'])
    expect(texts('echo "`date; whoami`" | cat')).toEqual(['echo "`date; whoami`"', 'cat'])
    expect(texts('x=$(a $(b && c) | d) && e')).toEqual(['x=$(a $(b && c) | d)', 'e'])
    expect(texts('echo `a \\`b; c\\`` ; d')).toEqual(['echo `a \\`b; c\\``', 'd'])
    expect(texts("echo $(echo ')' ; x) && y")).toEqual(["echo $(echo ')' ; x)", 'y'])
    expect(texts('diff <(a; b) <(c | d) && e')).toEqual(['diff <(a; b) <(c | d)', 'e'])
  })
  test('arithmetic, [[ ]] and case terminators are not split', () => {
    expect(texts('echo $((1 << 2 | 1)) && x')).toEqual(['echo $((1 << 2 | 1))', 'x'])
    expect(texts('((i++)) || exit 1')).toEqual(['((i++))', 'exit 1'])
    expect(texts('[[ -f a || -f b ]] && echo yes')).toEqual(['[[ -f a || -f b ]]', 'echo yes'])
    expect(texts('case $x in a) one;; b) two;& c) three;;& esac')).toEqual(['case $x in a) one;; b) two;& c) three;;& esac'])
  })
  test('>| is a redirection, not a pipe', () => {
    expect(texts('echo a >| out && b')).toEqual(['echo a >| out', 'b'])
  })
  test('a comment starts after an operator or a newline too', () => {
    expect(texts('a;# b && c\nd')).toEqual(['a', '# b && c', 'd'])
    expect(texts('a\n# b && c')).toEqual(['a', '# b && c'])
    expect(texts('echo a#b && c')).toEqual(['echo a#b', 'c'])
    expect(texts('echo $# && c')).toEqual(['echo $#', 'c'])
  })
  test('heredoc delimiters can be quoted or escaped, and bodies inside $( ) stay whole', () => {
    expect(texts('cat <<\\EOF\nrm -rf x && y\nEOF\nnext')).toEqual(['cat <<\\EOF\nrm -rf x && y\nEOF', 'next'])
    expect(texts('cat <<"E"OF\na; b\nEOF\nnext')).toEqual(['cat <<"E"OF\na; b\nEOF', 'next'])
    expect(texts("cat << 'EOF' | sh\nrm a; rm b\nEOF\nnext")).toEqual(["cat << 'EOF'", "sh\nrm a; rm b\nEOF", 'next'])
    expect(texts("x=$(cat <<'EOF'\n) ; evil\nEOF\n) && y")).toEqual(["x=$(cat <<'EOF'\n) ; evil\nEOF\n)", 'y'])
    expect(texts('cat <<A <<B\n1 && 2\nA\n3 ; 4\nB\nnext')).toEqual(['cat <<A <<B\n1 && 2\nA\n3 ; 4\nB', 'next'])
  })
  test('an unterminated quote or substitution keeps the rest whole', () => {
    expect(texts(`echo "a && b`)).toEqual([`echo "a && b`])
    expect(texts('a && echo $(b; c')).toEqual(['a', 'echo $(b; c'])
  })
  test('no character of the command is ever lost', () => {
    const samples = [
      'pnpm run typecheck && bun test src', `git commit -m "fix: a && b" && git push`, 'a | b |& c || d; e & f', 'cat <<-X\n\tbody\n\tX\nnext',
      'for f in *.ts; do echo "$f"; done', 'if [ -f a ]; then rm a; fi', '{ a; b; } > out', 'echo ${#arr[@]} && x', "echo '\\' && y",
    ]
    for (const command of samples) {
      const rebuilt = splitShell(command).map((s) => (s.op && s.op !== '\n' ? s.op : '') + s.text).join('')
      expect(rebuilt.replace(/\s+/g, '')).toBe(command.replace(/;\s*$/, '').replace(/\s+/g, ''))
    }
  })
  test('CRLF is treated as newlines', () => {
    expect(texts('a\r\nb')).toEqual(['a', 'b'])
  })
})

describe('shellTokens', () => {
  test('names the command, flags, strings, redirections and assignments', () => {
    expect(shellTokens(`FOO=1 bun test src --timeout 20000 "a b" 2>&1`)).toEqual([
      { text: 'FOO=1', kind: 'var' },
      { text: 'bun', kind: 'cmd' },
      { text: 'test', kind: 'arg' },
      { text: 'src', kind: 'arg' },
      { text: '--timeout', kind: 'flag' },
      { text: '20000', kind: 'arg' },
      { text: '"a b"', kind: 'str' },
      { text: '2>&1', kind: 'op' },
    ])
  })
  test('a quoted word with spaces is one token', () => {
    expect(shellTokens(`git commit -m 'fix: a && b'`).map((t) => t.text)).toEqual(['git', 'commit', '-m', `'fix: a && b'`])
  })
})

describe('commandRows and clampRows', () => {
  test('a heredoc body is a gutterless body row and the gutter follows the operator', () => {
    expect(commandRows('a && cat <<E\nx\nE')).toEqual([
      { gutter: '$', text: 'a', body: false },
      { gutter: '&&', text: 'cat <<E', body: false },
      { gutter: '', text: 'x', body: true },
      { gutter: '', text: 'E', body: true },
    ])
    expect(gutterOf('\n')).toBe('$')
  })
  test('six lines or fewer are never clamped', () => {
    const rows = commandRows('a && b && c && d && e && f')
    expect(clampRows(rows)).toEqual({ rows, total: 6, clamped: false })
  })
  test('more than six lines clamp to six and report the whole count', () => {
    const rows = commandRows('a && b && c && d && e && f && g && h')
    const clamped = clampRows(rows)
    expect(clamped.clamped).toBe(true)
    expect(clamped.total).toBe(8)
    expect(clamped.rows).toHaveLength(6)
  })
  test('a long row counts for every line it wraps to', () => {
    const rows = commandRows(`echo ${'x'.repeat(200)} && b`)
    const clamped = clampRows(rows, 3)
    expect(clamped.clamped).toBe(true)
    expect(clamped.rows).toHaveLength(1)
    expect(clampRows(commandRows('x'.repeat(2000)), 6).rows[0]!.text.endsWith('…')).toBe(true)
  })
})

describe('commandNames', () => {
  test('lists each command a chain runs', () => {
    expect(commandNames('cd apps/gpuix && pnpm install | tee x.log; FOO=1 git status')).toEqual(['cd', 'pnpm', 'tee', 'git'])
  })
})
