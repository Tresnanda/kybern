// A resumed thread subscription whose gap is too large comes back as a fresh
// snapshot instead of a replay (#248); live events after the snapshot's head
// continue it, and the next resume starts from that head.
import test from "node:test";
import assert from "node:assert/strict";
import { KybernClient } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";
import { trackClients, until } from "./clients.mjs";

const track = trackClients();

function fakeDaemon(onCall) {
  const sockets = [];
  const createSocket = () => {
    const socket = {
      readyState: 1,
      sent: [],
      close() {},
      send(text) {
        queueMicrotask(() => socket.receive(text));
      },
      receive(text) {
        const frame = JSON.parse(text);
        socket.sent.push(frame);
        const reply = (result) => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) });
        if (frame.method === "daemon.info") reply({ protocol_version: PROTOCOL_VERSION, environment_id: "env" });
        else onCall(frame, reply, (method, params) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) }), 0));
      },
    };
    sockets.push(socket);
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
  return { sockets, createSocket };
}

const page = { thread: { id: "t1", last_seq: 50 }, transcript: [], pending_approvals: [] };

test("a large gap answers with a snapshot, then live events continue it", async () => {
  const daemon = fakeDaemon((frame, reply, notify) => {
    if (frame.method !== "events.subscribe") return reply({});
    reply({ subscription_id: "s1", head_seq: 50, replay_ready: true, snapshot: page });
    notify("event", { subscription_id: "s1", event: { seq: 51, thread_id: "t1", kind: "x" } });
    notify("events.ready", { subscription_id: "s1", head_seq: 50 });
  });
  const client = track(new KybernClient({ url: "ws://127.0.0.1:1/ws", token: "t" }, { createSocket: daemon.createSocket }));
  const order = [];
  const sub = client.subscribeEvents(
    { thread_id: "t1", after_seq: 10, gap_snapshot: { thread_id: "t1", transcript_limit: 60 } },
    (event) => order.push(["event", event.seq]),
    (head) => order.push(["subscribed", head]),
    undefined,
    (snapshot, head) => order.push(["snapshot", snapshot.thread.last_seq, head]),
  );
  client.connect();
  // The live event is delivered from a timer after the reply, so wait for it rather than for a fixed time.
  await until(() => order.length >= 3, "the snapshot, the subscription and the live event");
  const subscribe = daemon.sockets[0].sent.find((frame) => frame.method === "events.subscribe");
  assert.equal(subscribe.params.after_seq, 10);
  assert.deepEqual(subscribe.params.gap_snapshot, { thread_id: "t1", transcript_limit: 60 });
  assert.deepEqual(order, [
    ["snapshot", 50, 50],
    ["subscribed", 50],
    ["event", 51],
  ]);
  assert.equal(sub.lastSeq, 51);
  client.close();
});

test("without a snapshot handler the client never asks for one", async () => {
  const daemon = fakeDaemon((frame, reply) => reply(frame.method === "events.subscribe" ? { subscription_id: "s1", head_seq: 5 } : {}));
  const client = track(new KybernClient({ url: "ws://127.0.0.1:1/ws", token: "t" }, { createSocket: daemon.createSocket }));
  client.subscribeEvents({ thread_id: "t1", after_seq: 1, gap_snapshot: { thread_id: "t1" } }, () => {});
  client.connect();
  await until(() => daemon.sockets[0]?.sent.some((frame) => frame.method === "events.subscribe"), "the subscribe request");
  const subscribe = daemon.sockets[0].sent.find((frame) => frame.method === "events.subscribe");
  assert.equal("gap_snapshot" in subscribe.params, false);
  client.close();
});
