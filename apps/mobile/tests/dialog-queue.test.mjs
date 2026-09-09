import assert from "node:assert/strict";
import test from "node:test";
import { createDialogQueue } from "../src/ui/dialogQueue.ts";

test("a destructive confirmation executes once after exit, and never on dismissal", () => {
  const queue = createDialogQueue();
  let removed = 0;
  let canceled = 0;
  const request = {
    title: "Remove project?",
    buttons: [
      { text: "Cancel", style: "cancel", onPress: () => canceled++ },
      { text: "Remove", style: "destructive", onPress: () => removed++ },
    ],
  };
  queue.enqueue(request);
  const first = queue.getSnapshot().id;
  queue.finish(first, 0);
  queue.finish(first, 1);
  assert.equal(canceled, 1);
  assert.equal(removed, 0);
  queue.enqueue(request);
  const second = queue.getSnapshot().id;
  queue.finish(second, 1);
  queue.finish(second, 1);
  assert.equal(removed, 1);
  assert.equal(queue.getSnapshot(), null);
});

test("a prompt delivers the edited value and a nested alert survives its callback", () => {
  const queue = createDialogQueue();
  let name;
  queue.enqueue({
    title: "Rename",
    prompt: { defaultValue: "Before", secure: false },
    buttons: [
      {
        text: "Save",
        onPress: (value) => {
          name = value;
          queue.enqueue({ title: "Saved", buttons: [{ text: "OK" }] });
        },
      },
    ],
  });
  const id = queue.getSnapshot().id;
  queue.finish(id, 0, "After");
  assert.equal(name, "After");
  assert.equal(queue.getSnapshot().title, "Saved");
  queue.finish(id, 0, "Duplicate");
  assert.equal(queue.getSnapshot().title, "Saved");
  assert.equal(name, "After");
});

test("queued alerts retain order and passive dismissal calls only onDismiss", () => {
  const queue = createDialogQueue();
  const events = [];
  const unsubscribe = queue.subscribe(() =>
    events.push(queue.getSnapshot()?.title),
  );
  let dismissed = 0;
  queue.enqueue({
    title: "First",
    cancelable: true,
    onDismiss: () => dismissed++,
    buttons: [
      {
        text: "Confirm",
        onPress: () => assert.fail("Passive dismissal must not confirm"),
      },
    ],
  });
  queue.enqueue({ title: "Second", buttons: [{ text: "OK" }] });
  queue.finish(queue.getSnapshot().id, null);
  assert.equal(dismissed, 1);
  assert.equal(queue.getSnapshot().title, "Second");
  unsubscribe();
  queue.finish(queue.getSnapshot().id, 0);
  assert.deepEqual(events, ["First", "First", "Second"]);
});
