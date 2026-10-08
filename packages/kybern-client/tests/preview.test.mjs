import assert from "node:assert/strict";
import test from "node:test";
import { classifyPreviewInput, previewDisplay, validateBridgeMessage } from "../src/previewTarget.ts";
import {
  clampViewport, fitAxis, fitScale, isViewportSizeValid, parseViewportField, resizeViewport,
  rotateViewport, VIEWPORT_PRESETS,
} from "../src/previewViewport.ts";
import {
  clampPlayerSize, cornerPosition, defaultPlayerSize, nearestCorner, project, resizeHandleCorner,
} from "../src/previewMiniPlayer.ts";
import { addRecent, parseRecents, removeRecent, serializeRecents } from "../src/previewRecents.ts";

const ctx = { projectRoot: "/Users/me/ade-34", projectName: "ade-34", home: "/Users/me" };
const kind = (text) => classifyPreviewInput(text, ctx).kind;

test("servers: loopback and private networks", () => {
  for (const text of [
    "localhost:5173", "localhost:3000", "http://localhost", "https://localhost:8443/x", "127.0.0.1:8080",
    "http://127.5.5.5", "http://[::1]:3000", "[::1]:3000", "0.0.0.0:80", "app.localhost:3000",
    "10.1.2.3:8000", "172.16.0.1", "172.31.255.1:80", "192.168.1.5:3000", "100.64.0.1:80",
    "100.127.255.255", "mac.local:3000", "http://studio.local/x", "5173", ":5173",
  ]) assert.equal(kind(text), "server", text);
  assert.equal(classifyPreviewInput("5173").url, "http://localhost:5173/");
  assert.equal(classifyPreviewInput(":5173").port, 5173);
  const t = classifyPreviewInput("localhost:3000/a?b=1");
  assert.deepEqual([t.host, t.port, t.scope], ["localhost:3000", 3000, "loopback"]);
  assert.equal(classifyPreviewInput("192.168.1.5").scope, "private");
});

test("public hosts are external, including userinfo and lookalike tricks", () => {
  for (const text of [
    "https://example.com", "example.com", "http://172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.0.1",
    "http://127.0.0.1@evil.com", "http://localhost@evil.com/", "http://evil.com#@localhost",
    "http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://notlocal.com", "http://192.169.1.1",
    "127.0.0.1@evil.com", "https://example.com/page.html", "example.com/page.html",
  ]) assert.equal(kind(text), "external", text);
  assert.equal(classifyPreviewInput("http://127.0.0.1@evil.com").host, "evil.com");
  // user:pass on a real local host is still a local server.
  assert.equal(kind("http://evil.com@127.0.0.1:3000"), "server");
});

test("files", () => {
  assert.deepEqual(classifyPreviewInput("./a.html", ctx), { kind: "file", path: "/Users/me/ade-34/a.html", relative: "a.html" });
  assert.deepEqual(classifyPreviewInput("a/b.html", ctx), { kind: "file", path: "/Users/me/ade-34/a/b.html", relative: "a/b.html" });
  assert.deepEqual(classifyPreviewInput("../x.html", ctx), { kind: "file", path: "/Users/me/x.html" });
  assert.deepEqual(classifyPreviewInput("~/x.html", ctx), { kind: "file", path: "/Users/me/x.html" });
  assert.deepEqual(classifyPreviewInput("/abs/dir/../p.html"), { kind: "file", path: "/abs/p.html" });
  assert.deepEqual(classifyPreviewInput("file:///tmp/My%20File.html#top"), { kind: "file", path: "/tmp/My File.html" });
  assert.deepEqual(classifyPreviewInput("mock/index.html"), { kind: "file", path: "mock/index.html" });
  assert.equal(kind("v1.2/index.html"), "file");
  assert.equal(kind("file://other-host/x.html"), "rejected");
  assert.equal(kind("//evil.com/x"), "rejected");
});

test("bare words, empty and rejected schemes", () => {
  assert.deepEqual(classifyPreviewInput("react docs"), { kind: "search", query: "react docs" });
  assert.equal(kind("react"), "search");
  assert.equal(kind("   "), "empty");
  assert.equal(kind("99999"), "search");
  for (const text of [
    "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "blob:http://x/1", "about:blank",
    "tauri://localhost", "ipc://localhost/x", "kybern://computer", "mailto:a@b.c", "ftp://x", "ws://localhost:1",
  ]) assert.equal(kind(text), "rejected", text);
  assert.equal(classifyPreviewInput("javascript:alert(1)").reason, "scheme");
});

test("display strings", () => {
  const text = (input) => previewDisplay(classifyPreviewInput(input, ctx), ctx).segments.map((s) => s.text).join("|");
  assert.equal(text("localhost:5173/dashboard?tab=2"), "localhost:5173|/dashboard?tab=2");
  assert.equal(text("localhost:5173"), "localhost:5173");
  assert.equal(text("./mock/a.html"), "ade-34 › mock › |a.html");
  assert.equal(text("a.html"), "ade-34 › |a.html");
  assert.equal(text("/Users/me/Downloads/ade-34/mockup.html"), "…/ade-34/|mockup.html");
  const d = previewDisplay(classifyPreviewInput("/tmp/x.html", ctx), ctx);
  assert.equal(d.full, "/tmp/x.html");
  assert.equal(d.segments.at(-1).emphasis, true);
});

test("bridge messages", () => {
  assert.deepEqual(validateBridgeMessage({ source: "kybern-preview", type: "nav-start", extra: 1 }), { source: "kybern-preview", type: "nav-start" });
  const nav = { source: "kybern-preview", type: "nav", path: "/a", title: "T", back: 0, forward: 2 };
  assert.deepEqual(validateBridgeMessage({ ...nav, junk: true }), nav);
  for (const bad of [
    null, "x", [], {}, { ...nav, source: "other" }, { ...nav, type: "x" }, { ...nav, path: "x".repeat(2049) },
    { ...nav, title: "x".repeat(257) }, { ...nav, back: 1.5 }, { ...nav, forward: -1 }, { ...nav, back: "1" }, { ...nav, path: 3 },
  ]) assert.equal(validateBridgeMessage(bad), null);
  assert.ok(validateBridgeMessage({ ...nav, path: "x".repeat(2048), title: "x".repeat(256) }));
});

test("viewport presets, clamp, rotate and fit", () => {
  assert.equal(VIEWPORT_PRESETS.length, 8);
  assert.deepEqual(VIEWPORT_PRESETS.map((p) => p.group), ["phone", "phone", "phone", "phone", "tablet", "tablet", "desktop", "desktop"]);
  assert.equal(new Set(VIEWPORT_PRESETS.map((p) => p.id)).size, 8);
  assert.deepEqual(clampViewport({ w: 100, h: 9000 }), { w: 240, h: 3840 });
  const big = clampViewport({ w: 3840, h: 3840 });
  assert.ok(big.w * big.h <= 3840 * 2160 && big.w >= 240 && big.h >= 240);
  assert.deepEqual(clampViewport({ w: 3840, h: 2160 }), { w: 3840, h: 2160 });
  assert.deepEqual(clampViewport({ w: 239.6, h: 500 }), { w: 240, h: 500 });
  assert.equal(isViewportSizeValid(3840, 2160), true);
  assert.equal(isViewportSizeValid(3840, 2161), false);
  assert.equal(isViewportSizeValid(239, 500), false);
  assert.equal(parseViewportField(" 375 "), 375);
  assert.equal(parseViewportField("37.5"), null);
  assert.equal(parseViewportField("abc"), null);
  assert.deepEqual(rotateViewport({ w: 375, h: 667 }), { w: 667, h: 375 });
  assert.equal(fitScale({ w: 375, h: 667 }, { w: 800, h: 900 }), 1);
  assert.equal(fitScale({ w: 1000, h: 500 }, { w: 524, h: 900 }), 0.5);
  assert.equal(fitScale({ w: 500, h: 1000 }, { w: 900, h: 524 }), 0.5);
});

test("viewport resize divides by scale, keeps grab offset, locks aspect", () => {
  const base = { start: { w: 400, h: 600 }, startPointer: { x: 100, y: 100 } };
  assert.deepEqual(resizeViewport({ ...base, edge: "e", pointer: { x: 150, y: 999 }, scale: 0.5 }), { w: 500, h: 600 });
  assert.deepEqual(resizeViewport({ ...base, edge: "s", pointer: { x: 0, y: 140 }, scale: 1 }), { w: 400, h: 640 });
  assert.deepEqual(resizeViewport({ ...base, edge: "se", pointer: { x: 120, y: 130 }, scale: 1 }), { w: 420, h: 630 });
  assert.deepEqual(resizeViewport({ ...base, edge: "se", pointer: { x: 140, y: 100 }, scale: 1, shift: true }), { w: 440, h: 660 });
  assert.deepEqual(resizeViewport({ ...base, edge: "e", pointer: { x: 200, y: 100 }, scale: 1, shift: true }), { w: 500, h: 750 });
  assert.deepEqual(resizeViewport({ ...base, edge: "e", pointer: { x: -900, y: 100 }, scale: 1 }), { w: 240, h: 600 });
  assert.deepEqual(fitAxis("w", { w: 375, h: 667 }, { w: 700, h: 500 }), { w: 676, h: 667 });
  assert.deepEqual(fitAxis("h", { w: 375, h: 667 }, { w: 700, h: 500 }), { w: 375, h: 476 });
});

test("mini player size, projection and corners", () => {
  assert.deepEqual(defaultPlayerSize({ w: 1600, h: 900 }), { w: 320, h: 180 });
  assert.deepEqual(defaultPlayerSize({ w: 1, h: 1 }), { w: 320, h: 320 });
  assert.deepEqual(defaultPlayerSize({ w: 390, h: 844 }), { w: 240, h: 320 });
  assert.deepEqual(defaultPlayerSize({ w: 1000, h: 100 }), { w: 320, h: 150 });
  assert.deepEqual(clampPlayerSize({ w: 2000, h: 2000 }, { w: 1000, h: 800 }), { w: 500, h: 480 });
  assert.deepEqual(clampPlayerSize({ w: 10, h: 10 }, { w: 1000, h: 800 }), { w: 240, h: 150 });
  assert.equal(Math.round(project(1000)), 499);
  assert.equal(project(0), 0);
  const bounds = { w: 1000, h: 800 }, size = { w: 320, h: 180 }, opt = { bottomInset: 120 };
  assert.deepEqual(cornerPosition("top-left", size, bounds, opt), { x: 12, y: 12 });
  assert.deepEqual(cornerPosition("bottom-right", size, bounds, opt), { x: 668, y: 500 });
  assert.deepEqual(cornerPosition("bottom-left", size, bounds), { x: 12, y: 608 });
  assert.equal(nearestCorner({ x: 600, y: 400 }, { x: 0, y: 0 }, size, bounds, opt), "bottom-right");
  assert.equal(nearestCorner({ x: 300, y: 100 }, { x: 0, y: 0 }, size, bounds, opt), "top-left");
  // A flick to the left carries a player resting on the right to the left side.
  assert.equal(nearestCorner({ x: 668, y: 500 }, { x: -2500, y: 0 }, size, bounds, opt), "bottom-left");
  assert.equal(nearestCorner({ x: 668, y: 500 }, { x: 0, y: -3000 }, size, bounds, opt), "top-right");
  assert.equal(resizeHandleCorner("bottom-right"), "top-left");
  assert.equal(resizeHandleCorner("top-left"), "bottom-right");
});

test("recents are newest first, deduped, capped and validated", () => {
  let list = [];
  for (let i = 0; i < 12; i++) list = addRecent(list, { kind: "server", value: `http://localhost:${3000 + i}/`, at: i });
  assert.equal(list.length, 10);
  assert.equal(list[0].value, "http://localhost:3011/");
  list = addRecent(list, { kind: "server", value: "http://localhost:3005/", at: 99, title: "t" });
  assert.equal(list.length, 10);
  assert.deepEqual(list[0], { kind: "server", value: "http://localhost:3005/", at: 99, title: "t" });
  assert.equal(list.filter((r) => r.value.endsWith(":3005/")).length, 1);
  assert.equal(addRecent(list, { kind: "file", value: "http://localhost:3005/", at: 100 }).length, 10);
  assert.equal(removeRecent(list, "server", "http://localhost:3005/").length, 9);
  assert.equal(removeRecent(list, "file", "http://localhost:3005/").length, 10);
  const round = parseRecents(serializeRecents(list));
  assert.deepEqual(round, list);
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("not json"), []);
  assert.deepEqual(parseRecents("{}"), []);
  const mixed = JSON.stringify([
    { kind: "file", value: "/a.html", at: 1 }, { kind: "bogus", value: "x", at: 2 }, { kind: "file", value: "", at: 3 },
    { kind: "file", value: "/a.html", at: 5 }, { kind: "external", value: "https://x.dev", at: "no" }, 7, null,
    { kind: "external", value: "https://x.dev", at: 4, title: 3 },
  ]);
  assert.deepEqual(parseRecents(mixed), [{ kind: "file", value: "/a.html", at: 5 }, { kind: "external", value: "https://x.dev", at: 4 }]);
});
