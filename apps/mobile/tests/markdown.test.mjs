import assert from "node:assert/strict";
import test from "node:test";
import {
  imagePlaceholderText,
  isRemoteImage,
  localImagePath,
  matchImageParagraph,
  splitImages,
  tableCells,
  tableColumnWidths,
} from "../src/ui/markdownModel.ts";

test("a paragraph that is one image matches with its caption and path", () => {
  assert.deepEqual(matchImageParagraph("![Caption](shots/a.png)"), { alt: "Caption", target: "shots/a.png" });
  assert.deepEqual(matchImageParagraph("![](https://x.test/a.webp)"), { alt: "", target: "https://x.test/a.webp" });
  assert.deepEqual(matchImageParagraph("![Home](~/Pictures/a.jpg)"), { alt: "Home", target: "~/Pictures/a.jpg" });
  assert.deepEqual(matchImageParagraph("![Abs](/Users/me/a.gif \"title\")"), { alt: "Abs", target: "/Users/me/a.gif" });
});

test("angle brackets carry paths with spaces and parentheses", () => {
  assert.deepEqual(matchImageParagraph("![x](<My shots/a (1).png>)"), { alt: "x", target: "My shots/a (1).png" });
});

test("text around an image is not an image paragraph and splits cleanly", () => {
  assert.equal(matchImageParagraph("See ![x](a.png) here"), null);
  assert.deepEqual(splitImages("See ![x](a.png) here"), [
    { text: "See" },
    { image: { alt: "x", target: "a.png" } },
    { text: "here" },
  ]);
  assert.deepEqual(splitImages("no images [link](a.png)"), []);
});

test("several images on their own lines stay separate and in order", () => {
  const parts = splitImages("![a](1.png)\n![b](2.png)");
  assert.deepEqual(parts.map((p) => ("image" in p ? p.image.target : p.text)), ["1.png", "2.png"]);
});

test("remote and local targets are told apart; other schemes are refused", () => {
  assert.equal(isRemoteImage("HTTPS://x.test/a.png"), true);
  assert.equal(isRemoteImage("a.png"), false);
  assert.equal(localImagePath("shots/a.png"), "shots/a.png");
  assert.equal(localImagePath("/abs/a.png"), "/abs/a.png");
  assert.equal(localImagePath("~/a.png"), "~/a.png");
  assert.equal(localImagePath("file:///Users/me/a.png"), "file:///Users/me/a.png");
  assert.equal(localImagePath("C:\\shots\\a.png"), "C:\\shots\\a.png");
  assert.equal(localImagePath("data:image/png;base64,AAAA"), null);
  assert.equal(localImagePath("javascript:alert(1)"), null);
  assert.equal(localImagePath(" "), null);
});

test("a placeholder reads the caption, else the file name, never a bare mark", () => {
  assert.equal(imagePlaceholderText({ alt: "Chart", target: "a.png" }), "Chart");
  assert.equal(imagePlaceholderText({ alt: "", target: "dir/shot.png" }), "shot.png");
  assert.equal(imagePlaceholderText({ alt: "", target: "" }), "Image");
});

test("table cells split on pipes, keep escaped pipes and ragged rows", () => {
  assert.deepEqual(tableCells("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(tableCells("a | b\\|c"), ["a", "b|c"]);
});

test("columns keep a readable minimum and widen only for long words", () => {
  const rows = [["Scenario", "fps"], ["short words that wrap", "a-very-long-unbreakable-identifier-name-here"]];
  const widths = tableColumnWidths(rows);
  assert.equal(widths[0], 180);
  assert.ok(widths[1] > 180 && widths[1] <= 260);
  assert.equal(tableColumnWidths([["a", "b"], ["c"]]).length, 2);
});
