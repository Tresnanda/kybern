import assert from "node:assert/strict";
import test from "node:test";
import { codeTokens } from "../src/ui/codeTokens.ts";
test("source highlighting preserves exact text and separates comments, strings and code", () => {
  const source =
    '/* const hidden = 42 */\nexport const answer = "hello \\"world\\""; // note\nreturn 42;';
  const tokens = codeTokens(source, "tsx");
  assert.equal(tokens.map((t) => t.text).join(""), source);
  assert.ok(
    tokens.some((t) => t.kind === "comment" && t.text.includes("const hidden")),
  );
  assert.ok(tokens.some((t) => t.kind === "keyword" && t.text === "export"));
  assert.ok(
    tokens.some((t) => t.kind === "string" && t.text.includes("world")),
  );
  assert.ok(tokens.some((t) => t.kind === "number" && t.text === "42"));
});
test("Python multiline strings and hash comments remain intact", () => {
  const source = '# return false\ndef hello():\n  return """first\nsecond"""\n';
  const tokens = codeTokens(source, "py");
  assert.equal(tokens.map((t) => t.text).join(""), source);
  assert.ok(
    tokens.some((t) => t.kind === "string" && t.text.includes("first\nsecond")),
  );
  assert.equal(tokens[0].kind, "comment");
});
