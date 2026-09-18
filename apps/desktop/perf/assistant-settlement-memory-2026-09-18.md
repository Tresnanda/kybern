# Assistant settlement memory

Date: 2026-09-18

## Result

Finalizing a large streamed assistant message used to join every segment into
one extra string and expand both that string and the canonical completion into
JavaScript arrays with `Array.from`. The transcript now compares the existing
segments directly and rewinds a UTF-16 high-surrogate match before slicing, so
the final text and segment ordering remain exact without those message-sized
temporary allocations.

This is a frontend allocation reduction for unusually large assistant answers.
It is not a whole-application RAM result and does not address the larger live
tool-output burst, which is allocated by WebSocket decoding before the frontend
can enroll the result in its bounded cache.

## Reproducible allocation check

Runtime: Node 24.15.0, arm64, macOS 27.0 (26A428). The fixture runs baseline
and candidate scans in separate child processes, starts each observation after
an explicit GC, and reconciles 8,000,000 ASCII characters followed by an astral
Unicode correction split across stream segments. Both paths find the same
8,000,000-code-unit safe prefix.

Run from `apps/desktop`:

```sh
node --expose-gc perf/assistant-settlement-memory.mjs
```

| Scan | Heap delta | Child max RSS |
| --- | ---: | ---: |
| Joined string + two `Array.from` arrays | 152.60 MiB | 238.14 MiB |
| Segment-wise scan | 22.91 MiB | 107.69 MiB |

The observed heap delta fell by 129.69 MiB and child-process max RSS by 130.45
MiB in this synthetic scan. Max RSS includes module loading and the input and
canonical strings; it is useful only as an isolated before/after comparison.
It does not predict savings for ordinary response sizes or a WKWebView process.

The transcript regression test splits a surrogate pair across assistant
segments, changes the astral character in the canonical completion, and asserts
the exact final string and segment contents. Desktop transcript tests and
desktop/mobile TypeScript checks cover the shared projection. A separate
20,000-case randomized comparison, including valid astral characters, isolated
surrogate code units and random segment boundaries, produced the same safe
prefix as the previous code-point-array algorithm in every case.

## Research and remaining priorities

The ECMAScript specification defines strings as sequences of UTF-16 code units
and `Array.from` creates array elements from an iterable. The implementation
therefore scans code units without allocating arrays and explicitly handles the
only unsafe slice boundary: a matched high surrogate followed by a differing
low surrogate. See the [ECMAScript String type](https://tc39.es/ecma262/#sec-ecmascript-language-types-string-type)
and [`Array.from`](https://tc39.es/ecma262/#sec-array.from).

WebKit's memory tooling separates JavaScript, decoded images, layers and other
page memory, so allocator and graphics growth need different fixes. See
[Memory Debugging with Web Inspector](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/).
Apple recommends downsampling large images to their display size because a
full-size decode consumes unnecessary memory; Kybern already fetches local
thumbnail previews and releases object URLs and image bitmaps. The inspected
long-session process had no resident Image IO pages at capture time. This does
not rule out decoded image storage in other WebKit or graphics categories;
image-heavy usage still needs a dedicated workload. See
[Making changes to reduce memory use](https://developer.apple.com/documentation/xcode/making-changes-to-reduce-memory-use)
and [`preparingThumbnail(of:)`](https://developer.apple.com/documentation/uikit/uiimage/preparingthumbnail(of:)).

The remaining work is ordered by expected impact:

1. Omit large completed tool outputs on the live daemon-to-client event and
   hydrate them on demand. A client-only cache cannot prevent `JSON.parse` from
   allocating the full frame first.
2. Measure hidden/idle demotion of transcript paint-host layers in native
   WebKit. Permanent promotion prevents the proven 4 MiB scroll-tile buildup,
   so changing it without a graphics-region before/after risks restoring the
   earlier multi-gigabyte regression.
3. Add page-aware omission and hydration for unusually large completed tool
   inputs. Active transcripts retain exact call inputs because labels and
   expanded details consume them; arbitrary truncation would lose content.
4. Cap inactive environment stores only if a multi-environment workload shows
   growth. Switching already compacts transcript blocks, diffs and runtime
   tasks, so this is lower priority for a single-environment daily session.
