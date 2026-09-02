# kybern desktop design notes

The bar: it should feel like Cursor or a first-party Apple app. Calm, dense
where it matters, empty where it does not, and nothing moves unless the
motion says something.

## Layout

Three panes, mirroring T3 Code:

1. **Sidebar** (240px, resizable 200–360): projects as section headers, threads
   beneath them. Status is a small dot before the title: none for idle, blue
   pulse for running, amber for awaiting approval, red for failed. Pinned
   threads sort first. No dividers between rows; grouping is spacing.
2. **Thread** (fills): transcript at top, composer pinned at the bottom.
   Transcript is a single column with a 720px measure. User messages are a
   quiet card on the trailing side; assistant text is bare markdown on the
   canvas. Tool calls are one-line rows ("Ran `git status`") that expand on
   click. Approval cards are the only element with a primary button in the
   transcript.
3. **Right panel** (360px, resizable, collapsible): tabs "Changes" and
   "Terminal". Changes lists files with +/- counts, then the patch below.

The title bar is transparent and the traffic lights sit over the sidebar.
No custom chrome beyond that.

## Type

System font (SF on macOS, Segoe on Windows). Body 13px / 1.5, transcript
markdown 14px / 1.6 with a 720px measure, sidebar 13px, captions 12px,
headings semibold rather than large. Monospace for code, paths, commands, and
token counts (tabular numbers). No weights under 400 anywhere.

## Color

Use the theme tokens; never hardcode. Structure comes from spacing, not lines:
the only borders are the pane edges and focus rings. Status colors are the
only saturated colors on screen: blue running, amber waiting, red failed,
green completed. Dark mode follows the system.

## Motion

- No animation on keyboard-driven or high-frequency actions: switching
  threads, sending, opening the palette.
- Streaming text appears as it arrives with no fade.
- Approval cards and notices enter with a 150ms opacity+4px rise, ease-out.
- Buttons scale to 0.97 on press.
- Panels resize 1:1 with the drag, no easing.

## Copy

Sentence case everywhere. Verb-first buttons: "Send", "Allow", "Always allow",
"Deny", "New thread", "Add project". Approval cards repeat the consequence in
the title ("Run `rm -rf build`?"). Errors say what to do next. Empty states
orient and offer one action.

## Status labels

| status | sidebar dot | label |
| --- | --- | --- |
| idle | none | — |
| running | blue | Working |
| awaiting-approval | amber | Needs approval |
| failed | red | Failed |
