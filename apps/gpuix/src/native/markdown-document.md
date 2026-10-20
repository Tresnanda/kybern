# Native Markdown documents

`markdownDocument.tsx` owns worker-parsed documents. `markdown.ts` remains the
styling API. Explorer previews and PR Summary use `DocumentMarkdown`, keeping
their existing parent scroller, layout, theme and link callbacks.

```tsx
const document = await createMarkdownDocument(renderer, { text: source })
// One host is enough: native paint instantiates intersecting blocks and rows.
<MarkdownRange document={document.id} revision={document.revision} theme={theme} />
// On replacement/unmount, including a late asynchronous completion:
releaseMarkdownDocument(renderer, document.id)
```

The source, canonical AST, reference definitions and neutral fence highlighting
belong to the document revision. Visible layout does not parse independent
source substrings. Metadata includes stable block IDs, source UTF-8 byte ranges
and kinds. `getMarkdownDocumentText` returns the exact source.
`getMarkdownDocumentLayout` returns the latest measured width, scale, block y
positions and heights, or null before measurement. Geometry is specific to the
rendered width/theme; it is not a source-invariant height estimate.

The native body retains exact block sizes, then binary-searches the viewport
with 160px overscan. Large lists, quotes, tables and fences have corresponding
interior geometry and instantiate only intersecting children. A table measures
all columns against the full table. A fence shares one full lexical parse.
Paragraph shaping retains canonical Unicode indices; giant wrapped paragraphs
paint shaped glyph slices rather than reparsed text fragments. Mixed-size inline
flow retains its original wrap positions and paragraph copy group.

Explorer reads and renders complete Markdown files through 2MiB, with no line
limit. Other file reads retain their existing 256KiB cap. Oversized/truncated
Markdown opens in the existing source view.

First layout measures the complete document to establish exact heights. This is
cold O(document) work, not a claim of bounded first-paint latency. Each cold
block uses a disposable element arena and layout engine, so temporary whole-document
elements do not set the live frame arena’s permanent capacity. No frame arena
objects or Taffy IDs survive it. Derived visible paint inputs expire after two
viewport generations; plain geometry and logical copy text remain until close.
The logical selection catalog preserves copy when input skips every intermediate
painted block. Hosts for separate ranges share that document-order catalog. A document body must have a single parent vertical scroller.

## Appending live answers

```ts
const next = await updateMarkdownDocument(renderer, document.id, {
  text: completeSourceSoFar,
  expectedRevision: document.revision,
})
```

The result reports `parsedBytes` and `stablePrefixBlocks`. An append backs up to
the previous two distinct top-level source boundaries, keeps indentation and
backs up a preceding quote/list for lazy continuation. Stable blocks retain their
Arc identity. Source replacements and sources containing reference definitions use a
conservative whole-source parse; a definition can resolve an earlier link. Tail
reuse currently applies to sources without definitions. A no-op parses zero bytes. Completion
can adopt the latest revision directly, without reparsing the final answer.

Keep one update in flight and coalesce subsequent text into the newest pending
source in the transcript owner. Apply only the newest result, preserve the host
identity, and release the handle even if its async creation resolves after the
answer unmounts. The API rejects stale expected revisions. Release and window
close cancel publication of in-flight revisions. Streaming caret/fade integration
must retain the existing paint-only animation path and be verified by the
transcript lane; this lane integrates settled Explorer/PR bodies only.

Limits: 2MiB per source, 16MiB aggregate registered source, 32 documents, eight
pending worker jobs. Source bytes do not count ASTs, fonts, glyph atlases or old
mounted revision leases; these are not process-footprint caps. The parser and
formatting features remain the existing native Markdown implementation. Transcript
adopters must retain their existing diagram, image and reference-chip adapters;
this API does not replace those application-level surfaces.

## Source techniques

The append boundary/reference invalidation follows
[Zeron parser.rs 1996–2165](https://github.com/zeronsh/zeron/blob/c02739da309118c2174f427511110046f0bfba16/crates/markdown/src/parser.rs#L1996-L2165).
Worker preparation and semantic preview blocks follow
[Zeron markdown_preview.rs 462–525](https://github.com/zeronsh/zeron/blob/c02739da309118c2174f427511110046f0bfba16/crates/ui/src/files/markdown_preview.rs#L462-L525).
Separating durable documents from viewport render inputs follows
[Zeron render.rs 421–495](https://github.com/zeronsh/zeron/blob/c02739da309118c2174f427511110046f0bfba16/crates/ui/src/markdown/render.rs#L421-L495),
and intersecting visible text work follows
[Zed editor element.rs 8690–8712](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/editor/src/element.rs#L8690-L8712).
The read-only source clones used for implementation are listed in
`perf/zeron-zed-techniques.md`.

Intrinsic size probes reuse the last ready measured width instead of invalidating
all row geometry at a temporary 320 px width. Definite width/scale changes and
source changes still remeasure. The native cost gate scrolls 1,500-row tables and
code fences before and after resizing and requires fewer than 1,000 layout calls
per warm frame; this catches accidental work proportional to container rows.
