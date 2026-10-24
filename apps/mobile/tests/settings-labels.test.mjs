import assert from "node:assert/strict";
import test from "node:test";
import {
  canManageAccess,
  connectionRoute,
  limitLabel,
  limitTone,
  permissionLabel,
  resetsLabel,
  shortAddress,
  staleLabel,
} from "../src/features/settings/labels.ts";

test("permission modes read like the composer", () => {
  assert.equal(permissionLabel("supervised"), "Ask before acting");
  assert.equal(permissionLabel("full-access"), "Full access");
});

test("code-paired phones cannot manage access", () => {
  assert.equal(canManageAccess(["orchestration_read", "orchestration_operate", "terminal_operate", "review_write"]), false);
  assert.equal(canManageAccess(["access_read", "access_write"]), true);
  assert.equal(canManageAccess(undefined), false);
});

test("the route comes from the address", () => {
  assert.equal(connectionRoute("ws://100.101.2.3:4199/ws"), "Tailscale");
  assert.equal(connectionRoute("wss://mac.tail1234.ts.net/ws"), "Tailscale");
  assert.equal(connectionRoute("ws://192.168.1.4:4199/ws"), "Local network");
  assert.equal(connectionRoute("ws://my-mac.local:4199/ws"), "Local network");
  assert.equal(connectionRoute("ws://127.0.0.1:4199/ws"), "This computer");
  assert.equal(connectionRoute("wss://kybern.example.com/ws"), "Internet");
  assert.equal(shortAddress("ws://192.168.1.4:4199/ws"), "192.168.1.4:4199");
});

test("limit windows use each vendor's words", () => {
  const session = { name: "five_hour", used_percent: 40, window_minutes: 300, resets_at: null };
  assert.equal(limitLabel(session, "claude-code"), "Current session");
  assert.equal(limitLabel(session, "codex"), "5-hour");
  assert.equal(limitLabel({ name: "monthlyCredits", used_percent: 1, window_minutes: null, resets_at: null }), "Monthly Credits");
  assert.equal(limitTone(50), "accent");
  assert.equal(limitTone(80), "warning");
  assert.equal(limitTone(95), "negative");
});

test("reset and stale copy", () => {
  const now = Date.UTC(2026, 9, 24, 12);
  assert.equal(resetsLabel(now / 1000 + 130 * 60, now), "Resets in 2h 10m");
  assert.equal(resetsLabel(now / 1000 + 25 * 3600, now), "Resets in 1d 1h");
  assert.equal(resetsLabel(null, now), null);
  assert.equal(staleLabel(undefined), null);
  assert.ok(staleLabel("login_refresh")?.includes("Sign in"));
});
