# Request cards

Every request that waits on the reader is one family (Direction B, "Option list"): header, the well that shows what is asked,
numbered rows, a hint line. Spec and tokens: `.kybern-artifacts/ade-approval-design/` (`spec.md`, `motion.md`, `src/req.css`).

| File | What |
| --- | --- |
| `model.ts` | `approvalCard(approval, provider)`: title, well and the rows (label, RPC) of every tool approval and consent kind. The rows, the key map and the RPC come from this one table, so they cannot drift. `sessionLabel` words the session option for what each harness really allows. |
| `shell.ts` | Splits the real `input.command` on `&&`, `\|\|`, `;`, `\|`, `\|&`, `&` and newlines (quotes, `$(…)`, heredocs and comments are not split) so `a && b` never reads as `a`. |
| `actions.ts` | `chooseRow`, `sendDecline`, `cancelTurn`, `handleCardKey`: what a click, a digit or a key does. The card and the composer share them. |
| `ui.ts` | Highlight, open note, choice in flight, expanded well; module state because the composer also routes keys. |
| `Card.tsx` | Header, wells (`CodeWell`, `DiffWell`, `PlanWell`, …), `OptionRow`, `NoteField`, `Hints`. |
| `ApprovalCard.tsx`, `Question.tsx`, `Secret.tsx`, `../coordinator/Cards.tsx` | The card kinds built from those parts. |

Keys: digits follow the visible order and Decline is always the last number. ↑ ↓ move the highlight (in the empty composer they hand
the keyboard to the card), Return picks the highlighted row only with the card focused (never from the composer), Esc cancels the turn
(forms ignore it), ⌘E expands a clamped well. A card that arrives while someone is typing never takes focus.

Decline opens a note field in the row. Claude's driver and the daemon's own cards (computer use, notes and tasks) carry the note as the
deny `reason`; every other driver drops it, so the note also goes as the next queued message.

Checks: `bun test src/requests`, `bun src/requests/keys.verify.ts` (native fixture; keys and notes), `SHOT_TAG=after SHOT_THEMES=dark,glass-dark bun src/requests/shots.ts`.
Run the fixtures with `NAPI_RS_NATIVE_LIBRARY_PATH` set to a patched addon.
