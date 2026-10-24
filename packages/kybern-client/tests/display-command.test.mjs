import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_TITLE_LIMIT, displayCommand } from "../src/displayCommand.ts";

const show = (command, options) => displayCommand(command, options).text;

test("a plain command is left alone", () => {
  assert.deepEqual(displayCommand("bun test src/transcript"), { text: "bun test src/transcript", truncated: false });
});

test("the rtk proxy prefix is dropped", () => {
  assert.equal(show("rtk git status"), "git status");
  assert.equal(show("rtk proxy git diff --stat"), "proxy git diff --stat");
  assert.equal(show("rtkit-helper run"), "rtkit-helper run");
});

test("a leading cd hop is dropped, however it is quoted", () => {
  assert.equal(show("cd /Users/mymac/projects/ade && cargo test -p kybern-store"), "cargo test -p kybern-store");
  assert.equal(show(`cd "/Users/my mac/ade" && pnpm typecheck`), "pnpm typecheck");
  assert.equal(show("cd '/tmp/kyb'; ls -la"), "ls -la");
  assert.equal(show("cd apps/mobile && cd src && rtk pnpm test"), "pnpm test");
});

test("a command that is only a cd keeps itself", () => {
  assert.equal(show("cd /Users/mymac/projects/ade"), "cd /Users/mymac/projects/ade");
});

test("trailing output trimming is dropped", () => {
  assert.equal(show("cargo build -p kybern 2>&1 | tail -n 40"), "cargo build -p kybern");
  assert.equal(show("pnpm lint 2>&1 | tail -20"), "pnpm lint");
  assert.equal(show("git log --oneline | head -5"), "git log --oneline");
  assert.equal(show("cargo test 2>&1 | tail"), "cargo test");
  assert.equal(show("pnpm test | grep -c ok"), "pnpm test | grep -c ok");
});

test("wrappers, cd, rtk and the trim come off together", () => {
  assert.equal(
    show(`/bin/zsh -lc "cd /Users/mymac/projects/ade && rtk cargo test -p kybern-daemon 2>&1 | tail -n 60"`),
    "cargo test -p kybern-daemon",
  );
});

test("whitespace and line breaks collapse to one line", () => {
  assert.equal(show("npx   eas-cli@latest\n  update   --branch preview"), "npx eas-cli@latest update --branch preview");
});

test("a title cut by the driver is marked", () => {
  const source = `cd /Users/mymac/projects/ade && rtk npx eas-cli@latest update --branch preview --environment preview --message "Mobile parity batch" --platform all --non-intera`.slice(0, COMMAND_TITLE_LIMIT);
  assert.equal(source.length, COMMAND_TITLE_LIMIT);
  const shown = displayCommand(source);
  assert.equal(shown.truncated, true);
  assert.ok(shown.text.endsWith("…"));
  assert.ok(shown.text.startsWith("npx eas-cli@latest update --branch preview"));
  assert.ok(!shown.text.includes("rtk") && !shown.text.includes("cd /Users"));
});

test("a cut trim tail is not left dangling", () => {
  const body = "cargo test --workspace --no-fail-fast -- --nocapture some::very::long::module::path::that::runs::on";
  const source = `${body} 2>&1 | ta`.padEnd(COMMAND_TITLE_LIMIT, " ").slice(0, COMMAND_TITLE_LIMIT);
  assert.equal(show(`${body} 2>&1 | ta`, { sourceLimit: `${body} 2>&1 | ta`.length }), `${body}…`);
  assert.ok(displayCommand(source).truncated);
});

test("a source under the driver limit is not marked", () => {
  assert.equal(displayCommand("x".repeat(COMMAND_TITLE_LIMIT - 1)).truncated, false);
});

test("max cuts the text and marks it", () => {
  const shown = displayCommand("bun test src/very/long/path/to/a/test/file.test.ts", { max: 20 });
  assert.deepEqual(shown, { text: "bun test src/very/l…", truncated: true });
  assert.equal(shown.text.length, 20);
  assert.equal(displayCommand("bun test", { max: 20 }).truncated, false);
});
