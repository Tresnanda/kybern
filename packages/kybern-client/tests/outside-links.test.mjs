import test from "node:test";
import assert from "node:assert/strict";
import { absoluteFileLinks, unlinkFileLinks } from "../src/outsideLinks.ts";

const text = [
  "Plan: [plan.md](/tmp/claude/scratch/plan.md:12) and [src](src/main.rs) and [site](https://example.com/x).",
  "![shot](/tmp/shot.png) and [again](</tmp/claude/scratch/plan.md#L3>).",
  "```md",
  "[example](/tmp/in-code.md)",
  "```",
].join("\n");

test("absolute file links are collected once, outside code, without images or web links", () => {
  assert.deepEqual(absoluteFileLinks(text), ["/tmp/claude/scratch/plan.md"]);
  assert.deepEqual(absoluteFileLinks("[a](C:/Users/me/a.txt) [b](file:///tmp/b.txt)"), ["C:/Users/me/a.txt", "/tmp/b.txt"]);
  assert.deepEqual(absoluteFileLinks("no links here"), []);
});

test("links to files a client cannot open show as plain text", () => {
  const out = unlinkFileLinks(text, new Set(["/tmp/claude/scratch/plan.md"]));
  assert.equal(out.split("\n")[0], "Plan: plan.md and [src](src/main.rs) and [site](https://example.com/x).");
  assert.equal(out.split("\n")[1], "![shot](/tmp/shot.png) and again.");
  assert.equal(out.split("\n")[3], "[example](/tmp/in-code.md)");
  assert.equal(unlinkFileLinks(text, new Set()), text);
});
