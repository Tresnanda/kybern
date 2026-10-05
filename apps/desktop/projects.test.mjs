import assert from "node:assert/strict"
import test from "node:test"

import { mergeProjects, selectsMissingProject } from "./src/state/projects.ts"

const project = (id, name, extra = {}) => ({
  id,
  name,
  path: `/work/${id}`,
  is_git: true,
  task_prefix: name.slice(0, 3).toUpperCase(),
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
})

test("a projects.changed list adds, updates and removes projects, keeping unchanged records", () => {
  const ade = project("a", "Ade")
  const shop = project("s", "Shop")
  const current = { [ade.id]: ade, [shop.id]: shop }

  const added = project("n", "New")
  const renamed = project("s", "Storefront", { updated_at: "2026-10-02T00:00:00Z" })
  const merged = mergeProjects(current, [{ ...ade }, renamed, added])

  assert.deepEqual(Object.keys(merged), ["a", "s", "n"], "in the daemon's order")
  assert.equal(merged.a, ade, "an unchanged project keeps its object")
  assert.equal(merged.s, renamed)
  assert.equal(merged.n, added)

  const removed = mergeProjects(merged, [merged.a])
  assert.deepEqual(Object.keys(removed), ["a"])
  assert.deepEqual(mergeProjects(removed, []), {})
  // A cleared override counts as a change even when the timestamp matches.
  const cleared = mergeProjects({ a: { ...ade, worktrees_default: true } }, [ade])
  assert.equal(cleared.a, ade)
})

test("only a draft in a removed project needs a new selection", () => {
  const projects = { a: project("a", "Ade") }
  assert.equal(selectsMissingProject({ kind: "draft", draft: { projectId: "gone" } }, projects), true)
  assert.equal(selectsMissingProject({ kind: "draft", draft: { projectId: "a" } }, projects), false)
  assert.equal(selectsMissingProject({ kind: "draft", draft: {} }, projects), false, "a free chat draft has no project")
  assert.equal(selectsMissingProject({ kind: "thread", id: "t" }, projects), false)
  assert.equal(selectsMissingProject({ kind: "none" }, projects), false)
})
