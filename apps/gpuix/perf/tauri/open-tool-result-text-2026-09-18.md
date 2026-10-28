# Open tool-result text — 2026-09-18

## Finding and change

A visible open `ToolResult` used a single
`<pre className="max-h-72 overflow-auto">` for the whole payload. Closed and
offscreen results already unmount (#43). An open, on-screen result still put
the full string in that overflow scroller, so Read-sized JSON allocated every
line even though only ~13 were visible.

`ToolResultText` keeps short results as that same `<pre>` identity. Larger
results split into source lines (and 2048-character wrap pieces) and mount
only the visible range plus overscan. The scroller has no `chat-paint-host`,
`will-change`, or `contain: paint`. Select-all of the mounted scroller copies
the original string; a partial selection is left alone. Display is not sliced
with ellipses.

This slice does not change `App.tsx`, `kit.css`, paint hosts, or hidden-window
compact.

## Reproduction and correctness

`toolResultText.test.mjs` checks concatenation identity, wrap splits without
inserted newlines, and copy-all of mounted rows. `tool-memory` opens a 6000-row
JSON result, checks the mounted DOM is smaller than the source, the prefix is
present, the last line is reachable, copy is the original stringify, and the
scroller has no paint host.

Native WebKit (macOS, production CSP), not run on this Linux VM:

```sh
node scripts/check-rendering.mjs tool-memory
```

## Measurement gap

Issue #37 acceptance is whole-app **MiB physical footprint** on Apple M1. The
385.1 MiB peak is 64 text Read results; this slice bounds the *open* scroller
DOM, not the inactive lease. Do not attribute a whole-app MiB delta until an
open-result native pair exists. Linux RSS is not a substitute.
