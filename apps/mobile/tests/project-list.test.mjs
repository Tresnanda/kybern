import assert from "node:assert/strict";
import test from "node:test";
import { homeOf, removeProjectTitle, shortPath } from "../src/state/projectList.ts";

test("project paths abbreviate the host's home", () => {
  assert.equal(homeOf("/Users/me/.kybern"), "/Users/me");
  assert.equal(homeOf("/tmp/scratch"), null);
  assert.equal(shortPath("/Users/me/projects/ade", "/Users/me"), "~/projects/ade");
  assert.equal(shortPath("/Users/meow/x", "/Users/me"), "/Users/meow/x");
  assert.equal(shortPath("/srv/app", null), "/srv/app");
  assert.equal(removeProjectTitle("kybern"), "Remove “kybern” from Kybern?");
});
