import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesSend,
  sendPartKey,
  usableSendRect,
  createOutgoingProjection,
} from "../src/state/sendTransition.ts";
const message = { parts: [{ type: "text", text: "Same words" }] };
const flight = {
  id: 1,
  receipt: { threadId: "a", messageId: "new" },
  message,
  sources: {},
};
test("send motion is tied to the acknowledged message, never an identical history row or another computer thread", () => {
  assert.equal(matchesSend(flight, "a", "old", message), false);
  assert.equal(matchesSend(flight, "b", "new", message), false);
  assert.equal(matchesSend(flight, "a", "new", message), true);
});

const row = (id, seq, content = message) => ({
  kind: "block",
  key: `turn:${id}`,
  nested: false,
  block: {
    kind: "user",
    id,
    seq,
    turnId: `turn-${id}`,
    at: "now",
    message: content,
  },
});
const outgoing = {
  id: 8,
  key: "outgoing-8",
  threadId: "a",
  sourceThreadId: "a",
  afterSeq: 10,
  at: "now",
  message,
  sources: {},
};
test("a pending send appears immediately and never takes an identical history row", () => {
  const project = createOutgoingProjection();
  const history = row("old", 5);
  const result = project([history], outgoing);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0], history);
  assert.equal(result.rows[1].key, outgoing.key);
  assert.equal(result.received, false);
});
test("event-before-receipt renders one pending message and only the receipt confirms delivery", () => {
  const project = createOutgoingProjection();
  const event = row("ack", 11);
  const provisional = project([event], outgoing);
  assert.equal(provisional.rows.length, 1);
  assert.equal(provisional.rows[0].key, outgoing.key);
  assert.equal(provisional.received, false);
  const receipt = { ...outgoing, receipt: { threadId: "a", messageId: "ack" } };
  assert.equal(project([event], receipt).received, true);
  const settled = project([event], null);
  assert.equal(settled.rows[0].key, outgoing.key);
  assert.equal(settled.rows[0].block, event.block);
  assert.equal(
    project([event, row("later", 20)], null).rows[0],
    settled.rows[0],
  );
});
test("receipt-before-event retains the optimistic message until its canonical row arrives", () => {
  const project = createOutgoingProjection();
  const receipt = { ...outgoing, receipt: { threadId: "a", messageId: "ack" } };
  assert.equal(project([], receipt).received, false);
  assert.equal(project([], receipt).rows[0].key, outgoing.key);
  assert.equal(project([row("ack", 11)], receipt).received, true);
});
test("concurrent identical messages remain distinct after receipt reconciliation", () => {
  const project = createOutgoingProjection();
  const other = row("other-client", 11);
  const ours = row("ours", 12);
  project([other], outgoing);
  const final = project([other, ours], {
    ...outgoing,
    receipt: { threadId: "a", messageId: "ours" },
  });
  assert.equal(final.rows.length, 2);
  assert.equal(final.rows[0], other);
  assert.equal(final.rows[1].key, outgoing.key);
});
test("canceling a failed send removes only its pending presentation", () => {
  const project = createOutgoingProjection();
  const history = row("old", 5);
  project([history], outgoing);
  assert.deepEqual(project([history], null).rows, [history]);
});
test("a freshly created thread can match its initial message without a message receipt", () => {
  const fresh = { ...flight, receipt: { threadId: "fresh" } };
  assert.equal(matchesSend(fresh, "fresh", "first", message), true);
  assert.equal(matchesSend(fresh, "a", "first", message), false);
  assert.equal(
    matchesSend(fresh, "fresh", "first", {
      parts: [{ type: "text", text: "Another message" }],
    }),
    false,
  );
});
test("attachment measurement identity survives removal of an earlier image", () => {
  const image = {
    type: "attachment",
    asset_id: "photo",
    media_type: "image/jpeg",
    name: "photo.jpg",
    size: 12,
  };
  assert.equal(sendPartKey(image, 0), sendPartKey(image, 3));
  assert.equal(usableSendRect({ x: 2, y: 3, width: 0, height: 40 }), false);
  assert.equal(usableSendRect({ x: NaN, y: 3, width: 40, height: 40 }), false);
  assert.equal(usableSendRect({ x: 2, y: 3, width: 40, height: 40 }), true);
});

test("a new thread still matches after the daemon resolves image uploads to inline data", () => {
  const sent = {
    type: "attachment",
    asset_id: "photo",
    media_type: "image/jpeg",
    name: "photo.jpg",
    size: 12,
  };
  const fresh = {
    ...flight,
    receipt: { threadId: "fresh" },
    message: { parts: [sent, ...message.parts] },
  };
  const received = {
    parts: [
      { type: "image", media_type: "image/jpeg", data: "base64" },
      ...message.parts,
    ],
  };
  assert.equal(matchesSend(fresh, "fresh", "first", received), true);
  assert.equal(matchesSend(fresh, "other", "first", received), false);
  assert.equal(
    matchesSend(fresh, "fresh", "first", {
      parts: [
        { ...received.parts[0], media_type: "image/png" },
        ...message.parts,
      ],
    }),
    false,
  );
});
