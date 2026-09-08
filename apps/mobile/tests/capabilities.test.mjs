import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityPart,
  commandText,
  composerTrigger,
  replaceComposerTrigger,
} from "../src/state/capabilities.ts";
import { parsePairingInvitation } from "../../../packages/kybern-client/src/address.ts";
test("plugins retain their native mention wire format and display name", () => {
  assert.deepEqual(
    capabilityPart({
      scope: "plugin",
      name: "figma",
      display_name: "Figma",
      path: "/plugins/figma",
      enabled: true,
    }),
    {
      type: "mention",
      name: "figma",
      display_name: "Figma",
      path: "/plugins/figma",
    },
  );
});
test("skills retain their file path and commands remain editable text", () => {
  assert.deepEqual(
    capabilityPart({
      scope: "project",
      name: "review",
      path: "/project/SKILL.md",
      enabled: true,
    }),
    { type: "skill", name: "review", path: "/project/SKILL.md" },
  );
  assert.equal(commandText("/review"), "/review ");
});
test("QR scanning accepts pairing links and rejects unrelated codes", () => {
  const link =
    "kybern://pair?url=" +
    encodeURIComponent("http://127.0.0.1:4199") +
    "&code=123456&environment=test-env";
  assert.equal(parsePairingInvitation(link)?.environmentId, "test-env");
  assert.equal(parsePairingInvitation("https://example.com"), null);
  assert.equal(parsePairingInvitation("kybern://pair?code=123456"), null);
});

test("typing triggers suggestions at the caret and preserves surrounding text", () => {
  const text = "Please use $review then continue";
  const end = text.indexOf(" then");
  const trigger = composerTrigger(text, { start: end, end });
  assert.deepEqual(trigger, {
    marker: "$",
    query: "review",
    start: 11,
    end: 18,
  });
  assert.deepEqual(replaceComposerTrigger(text, trigger), {
    text: "Please use  then continue",
    caret: 11,
  });
  assert.equal(
    composerTrigger("mail@company.com", { start: 16, end: 16 }),
    null,
  );
  assert.equal(composerTrigger("$review", { start: 0, end: 7 }), null);
  const file = "@src/features/Composer";
  assert.equal(
    composerTrigger(file, { start: file.length, end: file.length }).query,
    "src/features/Composer",
  );
  assert.equal(composerTrigger("/review", { start: 7, end: 7 }).marker, "/");
});
