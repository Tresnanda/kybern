import assert from "node:assert/strict";
import test from "node:test";
import { StackRouter } from "../node_modules/expo-router/build/react-navigation/routers/index.js";
import { boundRemoval } from "../src/ui/sheetRemoval.ts";

// An Android sheet holds back its removal until the close animation ends, then
// replays the action. The Agents sheet closes itself and pushes the child thread
// in the same tick, so the replay runs with the child on top.
const router = StackRouter({});
const options = { routeNames: ["thread/[id]", "agents"], routeParamList: {}, routeGetIdList: {} };
const stack = {
  stale: false,
  type: "stack",
  key: "stack",
  index: 2,
  routeNames: options.routeNames,
  preloadedRoutes: [],
  routes: [
    { key: "parent", name: "thread/[id]", params: { id: "parent" } },
    { key: "sheet", name: "agents" },
    { key: "child", name: "thread/[id]", params: { id: "child" } },
  ],
};
// What the sheet's navigation.dispatch sends for router.back(): its own source, no target.
const replay = (action) => router.getStateForAction(stack, { source: "sheet", ...action }, options);

test("a bare back replayed after a push pops the pushed thread (the bug)", () => {
  const next = replay({ type: "GO_BACK" });
  assert.deepEqual(next.routes.map((r) => r.key), ["parent", "sheet"]);
});

test("a bound back removes only the sheet and keeps the child open", () => {
  const next = replay(boundRemoval({ type: "GO_BACK" }, "sheet", "stack"));
  assert.deepEqual(next.routes.map((r) => r.key), ["parent", "child"]);
  assert.equal(next.index, 1);
});

test("a bound back with nothing pushed closes the sheet as before", () => {
  const closed = router.getStateForAction(
    { ...stack, index: 1, routes: stack.routes.slice(0, 2) },
    { source: "sheet", ...boundRemoval({ type: "GO_BACK" }, "sheet", "stack") },
    options,
  );
  assert.deepEqual(closed.routes.map((r) => r.key), ["parent"]);
});

test("other actions and already-bound pops pass through unchanged", () => {
  const navigate = { type: "NAVIGATE", payload: { name: "thread/[id]" } };
  assert.equal(boundRemoval(navigate, "sheet", "stack"), navigate);
  const pop = { type: "POP", payload: { count: 1 }, source: "other" };
  assert.equal(boundRemoval(pop, "sheet", "stack"), pop);
});
