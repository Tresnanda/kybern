import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALES,
  parseTextScale,
  scaleFont,
  scaleLine,
  scaleMetrics,
  scaleTypeTable,
  textScaleLabel,
} from "../src/ui/textScale.ts";

const table = {
  body: { fontSize: 17, lineHeight: 24, letterSpacing: -0.2, fontWeight: "400" },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontWeight: "400" },
  mono: { fontSize: 13, lineHeight: 20, fontFamily: "monospace" },
};

test("steps run small to large around a 100 % default", () => {
  assert.equal(DEFAULT_TEXT_SCALE, 1);
  assert.ok(TEXT_SCALES.includes(1));
  assert.deepEqual([...TEXT_SCALES].sort((a, b) => a - b), [...TEXT_SCALES]);
  assert.deepEqual(TEXT_SCALES.map(textScaleLabel), ["85%", "92%", "100%", "110%", "120%", "135%"]);
});

test("stored values parse back to a step; anything else is the default", () => {
  assert.equal(parseTextScale("1.2"), 1.2);
  assert.equal(parseTextScale("0.85"), 0.85);
  for (const bad of [null, undefined, "", "abc", "1.05", "2", "-1"]) assert.equal(parseTextScale(bad), 1);
});

test("the default size is the type table itself", () => {
  assert.equal(scaleTypeTable(table, 1), table);
  const style = { fontSize: 15 };
  assert.equal(scaleMetrics(style, 1), style);
});

test("font sizes keep a tenth of a point, line heights whole points", () => {
  assert.equal(scaleFont(17, 1.35), 23);
  assert.equal(scaleFont(13, 0.92), 12);
  assert.equal(scaleFont(15, 1.1), 16.5);
  assert.equal(scaleLine(24, 1.35), 32);
  assert.equal(scaleLine(18, 0.85), 15);
  // Line height never falls below the font size at any step.
  for (const scale of TEXT_SCALES)
    for (const role of Object.values(table))
      assert.ok(scaleLine(role.lineHeight, scale) >= scaleFont(role.fontSize, scale), `${scale}`);
});

test("a scaled table scales size and leading and keeps everything else", () => {
  const big = scaleTypeTable(table, 1.2);
  assert.deepEqual(big.body, { fontSize: 20.4, lineHeight: 29, letterSpacing: -0.2, fontWeight: "400" });
  assert.equal(big.mono.fontFamily, "monospace");
  assert.equal(table.body.fontSize, 17, "the source table is untouched");
});

test("one table per scale, shared by every caller", () => {
  assert.equal(scaleTypeTable(table, 1.1), scaleTypeTable(table, 1.1));
  assert.equal(scaleTypeTable(table, 1.1).body, scaleTypeTable(table, 1.1).body);
  assert.notEqual(scaleTypeTable(table, 1.1), scaleTypeTable(table, 1.2));
});

test("override styles scale only the metrics they set", () => {
  assert.deepEqual(scaleMetrics({ lineHeight: 22, fontWeight: "600" }, 1.2), { lineHeight: 26, fontWeight: "600" });
  const plain = { fontWeight: "600" };
  assert.equal(scaleMetrics(plain, 1.2), plain);
});
