# Code colours: GPUIX vs the desktop (2026-10-18, polish9)

The desktop colours transcript code with Shiki (VS Code TextMate grammars, `github-dark/light-default`). GPUIX's native
renderer uses syntect (Sublime grammars from bat's pack) and folds every scope into one of 24 `HighlightKind`s
(`SCOPE_PREFIXES`, `native/syntax/mod.rs`), each given one palette colour. The grammars disagree about which tokens get which
scope, and a kind is shared by tokens Shiki colours differently (a shell command and a shell variable are both
`variable.*` → `Variable`; `cd` is `support.function.builtin` → `FunctionBuiltin`, drawn like a function). That is why `cd`,
`pnpm` and `dev` differed: `cd` took the function purple (Shiki: constant blue), `pnpm` was a plain variable (Shiki: orange),
`dev` an unscoped word (Shiki: string blue).

## What changed (JS only, `transcript/kit.tsx` `LANGUAGE_KINDS`)

`cachedCodeTheme(theme, language)` gives each common language its own palette: the kinds whose Shiki colour differs
re-point to the Shiki slot most characters actually have, and shell colours its unscoped text (arguments) as a string.

## Method

A scratch crate (syntect 5.3 + two-face 0.5, the same grammars) dumped scope stacks per token; they were folded
with the native table and compared per character to Shiki's `github-dark-default` tokens over ~66 KB of real source (the repo's
TS/TSX/Rust/Python/shell/JSON/YAML/CSS plus stdlib Python and typical agent shell commands). Share of non-space characters with the
Shiki colour:

| language | characters | before | after |
| --- | --- | --- | --- |
| bash | 8002 | 59% | 84% |
| typescript (tsx, js) | 18575 | 90% | 95% |
| rust | 9155 | 61% | 68% |
| python | 9439 | 37% | 41% |
| json | 2749 | 64% | 100% |
| css | 4386 | 47% | 89% |
| yaml | 3548 | 83% | 83% |

Python is low because Sublime scopes docstrings as comments (Shiki: string) and that kind is also `#` comments, which stay grey.

## What a palette cannot fix (needs a native scope-mapping change)

- Shell: `&&`, `;` and `[ ]` are red/purple where Shiki leaves them plain; `-f` inside `[ ]` and assignments (`FOO=`) differ; a
  command and a variable share `Variable`, so variables take the command orange.
- TypeScript: `console` and types used as values; Rust: unscoped identifiers (`Self::new`, struct literals); Go: calls.
- YAML keys and values share one kind (Shiki: keys green).
- Fix there: split `variable.function.shell` into its own kind, or map `support.function.builtin` and
  `variable.parameter.option` separately. Native lane work (`native/**` is owned elsewhere this round).

Evidence: `previews/gpuix/phase2/polish9/{before,code,final-reduced0,final-reduced1}` (`polish9-code*` and `convo9-md-a` pairs).
