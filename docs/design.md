# kybern desktop design notes

The bar: it should feel like Synara and Codex. Calm, dense where it matters,
empty where it does not, and nothing moves unless the motion says something.
The desktop app vendors Synara's stylesheet, primitives and icon system; new
UI reuses those before inventing anything.

## Layout

1. **Sidebar** (256px, resizable 208–480, Codex-style theme tint over native
   material that follows window focus): a 46px drag strip with the sidebar
   toggle and back/forward, the
   brand row, then New thread / Pull requests / Usage, then projects with
   their threads nested beneath. Rows are 28px, 14px type. Status is a glyph
   before the trailing edge: stepped spinner for running, amber dot plus
   "Pending" for awaiting approval, red dot for failed. Pinned threads sort
   first. Hover reveals pin and archive.
2. **Thread** (fills, on the content card with a rounded top-left seam): a
   46px header with the provider glyph, the title, Hand off, the thread menu,
   the Environment toggle and the dock toggle. The transcript is a centered
   46rem column. User messages are quiet rounded bubbles on the trailing side
   at 80% width and share the composer's surface fill; assistant text is bare
   markdown. Work sits under a
   "Worked for Ns" disclosure with a hairline; tool rows are one line
   ("Reading `RTK.md`" while live, "Read `RTK.md`" when settled) and expand
   in place. A concrete live tool row replaces the generic "Thinking" fallback.
   "Edited N files" cards unfold their diffs inline. A tick rail on the left
   navigates messages. Threads can split left/right or top/bottom into a
   persisted binary layout, capped at a 2×2 grid. `⌘\` opens a split to the
   right and `⌘⇧\` opens one below; sidebar threads can also be dragged onto a
   pane edge. The focused pane owns keyboard actions, approvals, and floating
   controls. The message-navigation rail stays in the single-thread reading
   view and yields that space in constrained panes. Closing a pane collapses
   its parent into the remaining sibling.
3. **Composer** floats over the transcript on a frosted 1.2rem squircle:
   14px editor, then a footer with +, permission mode (Full access in
   orange), the model/effort picker and the ink-filled send circle. Queued
   follow-ups and the approval card stack above it as fused panels. The
   transcript and composer share one gutter so their edges line up. Inside a
   split pane that gutter matches the header at 12/20px, the radius tightens
   to 0.875rem and secondary footer labels collapse before controls overflow.
4. **Right dock** (42% of the window, min 416px, resizable): surface chips for
   Diff, Terminal and Explorer. Diff renders per-file cards with line numbers.
   Repository-scale diffs load stats first, render files in bounded batches,
   and fetch one file's patch only when its card opens.
   Terminal is a tab strip of shells and agent CLIs, full bleed. Explorer is a
   file tree with search next to a file viewer with a breadcrumb header.
5. **Environment card** (288px, floating at the right edge, toggled from the
   header): Changes, Local/worktree, branch, Commit and push, Repository,
   Pull request, Editor, Recap.

The title bar is transparent and the traffic lights sit over the sidebar.

## Type

System UI font, 14px base with Synara's scale (`--app-font-size-*`). Cal Sans
only for the brand word. JetBrains Mono for code, diffs and the terminal.
Transcript line height 1.625. Headings are weight 500–600, never large.

## Color

Use Synara's runtime tokens (`--color-text-foreground`, `--color-border`,
`--color-background-button-secondary-hover`, ...); never hardcode. Structure
comes from spacing and hairlines. Saturated color is reserved for status
(amber pending, red failed, green/red diff stats) and the orange Full access
accent. Dark and light both come from the same seed; the window material
shows through the sidebar.

## Motion

- No animation on keyboard-driven or high-frequency actions.
- Streaming text appears as it arrives; "Thinking" shimmers.
- Disclosures animate grid rows over 220ms ease-out; menus scale from their
  trigger; dialogs scale from 0.98.
- Sent messages rise 3px over 180ms. Split panes resize 1:1 with the drag,
  without transitional lag; only the focused-pane outline eases in.
- Buttons scale to 0.97 on press; the send circle grows to 1.05 on hover.

## Copy

Sentence case everywhere. Verb-first buttons: "Send", "Approve once",
"Always allow this session", "Decline", "New thread", "Add project".
Approval cards say what will happen ("Approve this command?"). Errors say
what to do next. Empty states orient and offer one action.
