import assert from "node:assert/strict";
import test from "node:test";
import { ANTIGRAVITY_FULL_ACCESS_NOTE, onlyFullAccess, permissionLockNote, permissionModeFor, permissionModesFor } from "../src/permissionModes.ts";
import { antigravityInstallCommand } from "../src/antigravity.ts";
import { PROVIDER_DISPLAY_NAME } from "../src/types.ts";
import { hasSignIn } from "../src/machineAgents.ts";

const ALL = ["supervised", "accept-edits", "auto", "full-access"];

test("Antigravity is locked to Full access, by kind or by the modes it reports", () => {
  assert.equal(onlyFullAccess("antigravity"), true);
  assert.equal(onlyFullAccess("claude-code"), false);
  assert.equal(onlyFullAccess({ kind: "antigravity", supported_permission_modes: ["full-access"] }), true);
  assert.equal(onlyFullAccess({ kind: "codex", supported_permission_modes: ["full-access"] }), true);
  assert.equal(onlyFullAccess({ kind: "codex", supported_permission_modes: ALL }), false);
  assert.equal(onlyFullAccess(null), false);
});

test("a locked harness gets Full access whatever was chosen", () => {
  assert.equal(permissionModeFor("antigravity", "supervised"), "full-access");
  assert.equal(permissionModeFor("codex", "supervised"), "supervised");
  assert.deepEqual(permissionModesFor("antigravity", ALL), ["full-access"]);
  assert.deepEqual(permissionModesFor("codex", ALL), ALL);
});

test("the note shows for Antigravity only", () => {
  assert.equal(permissionLockNote("antigravity"), ANTIGRAVITY_FULL_ACCESS_NOTE);
  assert.equal(ANTIGRAVITY_FULL_ACCESS_NOTE, "Antigravity only runs in Full access");
  assert.equal(permissionLockNote("cursor"), null);
});

test("Antigravity has a name, a sign-in and one installer per OS", () => {
  assert.equal(PROVIDER_DISPLAY_NAME.antigravity, "Antigravity");
  assert.equal(hasSignIn("antigravity"), true);
  assert.match(antigravityInstallCommand("win32"), /install\.ps1/);
  assert.match(antigravityInstallCommand("darwin"), /install\.sh/);
});
