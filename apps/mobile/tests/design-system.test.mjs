import assert from "node:assert/strict";
import test from "node:test";
import { menuAt, menuSections } from "../src/ui/menuModel.ts";
import { count, plural } from "../src/state/format.ts";

const noop = () => {};

test("a trailing destructive run becomes its own section", () => {
  const sections = menuSections([
    { title: "Pin", onPress: noop },
    { title: "Share…", onPress: noop },
    { title: "Delete", destructive: true, onPress: noop },
  ]);
  assert.deepEqual(sections.map((s) => s.map((i) => i.title)), [["Pin", "Share…"], ["Delete"]]);
});

test("a menu of only destructive items stays one section", () => {
  const sections = menuSections([{ title: "Delete forever", destructive: true }]);
  assert.deepEqual(sections.map((s) => s.length), [1]);
});

test("inline groups are sections and submenus stay nested", () => {
  const items = [
    { title: "Mark done" },
    { title: "Status", children: [{ title: "To do", checked: true }, { title: "Done" }] },
    { title: "Move", inline: true, children: [{ title: "Inbox" }, { title: "Later" }] },
    { title: "Delete task", destructive: true },
  ];
  assert.deepEqual(menuSections(items).map((s) => s.map((i) => i.title)), [
    ["Mark done", "Status"],
    ["Inbox", "Later"],
    ["Delete task"],
  ]);
  assert.deepEqual(menuAt(items, ["Status"]).map((i) => i.title), ["To do", "Done"]);
  assert.equal(menuAt(items, ["Missing"]), null);
});

test("plurals are chosen whole", () => {
  assert.equal(count(1, "helper"), "1 helper");
  assert.equal(count(3, "helper"), "3 helpers");
  assert.equal(count(0, "agent"), "0 agents");
  assert.equal(count(1, "process", "processes"), "1 process");
  assert.equal(plural(2, { one: "{n} needs you", other: "{n} need you" }), "2 need you");
  assert.equal(plural(1, { one: "{n} needs you", other: "{n} need you" }), "1 needs you");
  assert.equal(count(1200, "file"), "1,200 files");
});
