import assert from "node:assert/strict";
import test from "node:test";
import { KybernClient } from "../../../packages/kybern-client/src/client.ts";

function fixture() {
  const client = new KybernClient({ url: "ws://localhost", token: "test" });
  client._status = "open";
  const calls = [];
  client.callRaw = (method, params) => {
    calls.push({ method, params });
    return Promise.resolve({ skills: [{ name: "example" }] });
  };
  return { client, calls };
}
const params = { project_id: "one", provider: "codex" };
test("skill discovery shares requests and isolates projects, providers and clients", async () => {
  const { client, calls } = fixture();
  const first = client.call("skills.list", params);
  assert.equal(client.call("skills.list", params), first);
  await first;
  await client.call("skills.list", params);
  assert.equal(calls.length, 1);
  await client.call("skills.list", { ...params, project_id: "two" });
  await client.call("skills.list", { ...params, provider: "claude_code" });
  assert.equal(calls.length, 3);
  const other = fixture();
  await other.client.call("skills.list", params);
  assert.equal(other.calls.length, 1);
});
test("discovery expires and configuration changes invalidate cached results", async () => {
  const { client, calls } = fixture();
  await client.call("skills.list", params);
  for (const entry of client.skills.values()) entry.expires = 0;
  await client.call("skills.list", params);
  assert.equal(calls.length, 2);
  await client.call("integrations.change", {});
  await client.call("skills.list", params);
  assert.equal(calls.length, 4);
  client.close();
  assert.equal(client.skills.size, 0);
});
test("failed discovery can retry and the cache is bounded", async () => {
  const { client } = fixture();
  client.callRaw = () => Promise.reject(new Error("Disconnected"));
  await assert.rejects(client.call("skills.list", params));
  assert.equal(client.skills.size, 0);
  client.callRaw = () => Promise.resolve({ skills: [] });
  for (let i = 0; i < 40; i++) await client.call("skills.list", { ...params, project_id: String(i) });
  assert.equal(client.skills.size, 24);
});
