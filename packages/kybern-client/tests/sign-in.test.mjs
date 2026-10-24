import assert from "node:assert/strict";
import test from "node:test";
import { commandOf, printedText, signInRows } from "../src/signIn.ts";

const tool = (id, input, output, complete = true, stream = "") => ({
  kind: "tool", id: `tool:${id}`, turnId: "turn", at: "2026-10-23T00:00:00Z", seq: 1, origin: { kind: "root" }, call: { id, name: "Bash", input }, stream, output, isError: true, complete,
});

test("reads the command as a string, argv or cmd", () => {
  assert.equal(commandOf({ command: "gh pr create" }), "gh pr create");
  assert.equal(commandOf({ command: ["vercel", "deploy"] }), "vercel deploy");
  assert.equal(commandOf({ cmd: "eas build" }), "eas build");
  assert.equal(commandOf("gh"), "");
});

test("looks at stderr and the live stream too", () => {
  assert.ok(printedText({ stdout: "", stderr: "gh auth login" }, "").includes("gh auth login"));
  assert.equal(printedText(null, "No access token available"), "No access token available");
});

test("one chip per CLI: the latest finished failure in the turn", () => {
  const chips = signInRows([
    tool("a", { command: "gh pr create --fill" }, "To get started with GitHub CLI, please run:  gh auth login"),
    tool("b", { command: "vercel deploy --prebuilt" }, { stderr: "Error: No existing credentials found." }),
    tool("c", { command: "gh pr view" }, "You are not logged in to any GitHub hosts."),
    tool("d", { command: "gh pr list" }, null, false, "gh auth login"),
    tool("e", { path: "README.md" }, "gh auth login"),
  ]);
  assert.deepEqual([...chips.keys()].sort(), ["b", "c"]);
  assert.equal(chips.get("b")?.service, "Vercel");
});

test("no chip when nothing signed out", () => {
  assert.equal(signInRows([tool("a", { command: "ls" }, "ok")]).size, 0);
  assert.equal(signInRows([]).size, 0);
});
