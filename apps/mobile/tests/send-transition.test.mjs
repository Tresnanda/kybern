import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesSend,
  sendPartKey,
  usableSendRect,
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
