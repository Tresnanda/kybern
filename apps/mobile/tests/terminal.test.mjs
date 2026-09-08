import assert from "node:assert/strict";
import test from "node:test";
import { terminalEdit } from "../src/lib/terminalInput.ts";

test("native keyboard edits send only new text, deletion or a replacement", () => {
  assert.equal(terminalEdit("ec", "echo"), "ho");
  assert.equal(terminalEdit("echo", "ech"), "\x7f");
  assert.equal(terminalEdit("abc", "ax"), "\x7f\x7fx");
  assert.equal(terminalEdit("echo ", "echo hello world"), "hello world");
  assert.equal(terminalEdit("same", "same"), "");
});
test("Unicode composition edits do not send isolated surrogate halves", () => {
  assert.equal(terminalEdit("😀", "😃"), "\x7f😃");
  assert.equal(terminalEdit("word😀", "word"), "\x7f");
  assert.equal(terminalEdit("か", "漢"), "\x7f漢");
});
