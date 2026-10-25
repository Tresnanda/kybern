import test from "node:test";
import assert from "node:assert/strict";
import {
  coordinatorCardKind,
  coordinatorCardLine,
  cardPartsText,
  isCoordinatorCard,
  noteChangesProposalInput,
  noteChangesTitle,
  tidyOfferTitle,
} from "../src/coordinatorCards.ts";
import { pendingKind } from "../src/userInput.ts";

const card = {
  tool_name: "kybern_coordinator_notes",
  input: {
    reason: "The guard was removed.",
    changes: [
      { path: "1", note_id: "n1", note_title: "Auth", op: "supersede", text: "- new claim", supersedes: "old claim", category: "decision" },
      { path: "2", note_id: "n2", note_title: "Build", op: "append", text: "- another", category: "bogus" },
      { note_id: "n3", text: "no path, dropped" },
    ],
  },
};

test("the note-changes card is read row by row, dropping rows without a path", () => {
  const input = noteChangesProposalInput(card);
  assert.equal(input.reason, "The guard was removed.");
  assert.deepEqual(
    input.changes.map((change) => [change.path, change.op, change.supersedes, change.category]),
    [["1", "supersede", "old claim", "decision"], ["2", "append", null, null]],
  );
  assert.equal(noteChangesProposalInput({ tool_name: "other", input: {} }), null);
});

test("the card is a Coordinator card that waits for an answer, with its own titles and settled lines", () => {
  assert.equal(coordinatorCardKind(card), "notes");
  assert.equal(isCoordinatorCard(card), true);
  assert.equal(pendingKind(card), "question");
  assert.equal(noteChangesTitle(1), "Apply 1 note change?");
  assert.equal(noteChangesTitle(3), "Apply 3 note changes?");
  assert.equal(tidyOfferTitle(5), "5 notes may be outdated");
  const line = (decision, live) => cardPartsText(coordinatorCardLine(card, decision, live));
  assert.equal(line(null, true), "Waiting for you to review note changes");
  assert.equal(line({ decision: "submit", response: { accepted: ["1"] } }, true), "Applied 1 note change");
  assert.equal(line({ decision: "deny", reason: null }, true), "Declined note changes");
  assert.match(line(null, false), /Request ended/);
});
