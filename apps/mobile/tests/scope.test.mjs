import assert from "node:assert/strict";
import test from "node:test";

const { resolveScope, scopeLabel } = await import("../src/state/scopeModel.ts");

test("a remembered project outside the space falls back to All projects", () => {
  assert.equal(resolveScope("all", []), "all");
  assert.equal(resolveScope("global", []), "global");
  assert.equal(resolveScope("p1", ["p1", "p2"]), "p1");
  assert.equal(resolveScope("p3", ["p1", "p2"]), "all");
  assert.equal(resolveScope("p3", ["p1"], "p3"), "p3", "a linked project stays");
});

test("the filter reads All projects, Global, or the project's name", () => {
  const projects = [{ id: "p1", name: "kybern" }];
  assert.equal(scopeLabel("all", projects), "All projects");
  assert.equal(scopeLabel("global", projects), "Global");
  assert.equal(scopeLabel("p1", projects), "kybern");
  assert.equal(scopeLabel("gone", projects), "Project");
});
