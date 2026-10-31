import test from "node:test";
import assert from "node:assert/strict";
import { mergeProjects } from "../src/machineMerge.ts";
import { logicalSpace, prepareSpacePlacements, setSpacePlacements, spaceProject } from "../src/spacePlacements.ts";
import { deleteTarget } from "../src/spaces.ts";
const space = (id, is_default = false) => ({ id, name:id, is_default, position:0, color:"blue",logo:{kind:"initials"}, created_at:"2026-10-01Z",updated_at:"2026-10-01Z" });
const project = (id, roots=[], remote, extra={}) => ({ id, name:id, path:`/${id}`, repo:{root_commit:roots[0],root_commits:roots,remote}, kind:"single",...extra });
const assignment = (machine, p, space_id, lamport=1) => ({ project:spaceProject(machine,p),space_id,lamport,signer:machine,op_id:p.id });
const logical = (perMachine) => mergeProjects(new Map(perMachine))[0];

test("remote-only projects use the replica, default follows is_default after rail reorder", () => {
  const p=project("remote",["a"]);
  setSpacePlacements([space("work"),space("default",true)],[assignment("vps",p,"work")]);
  assert.equal(logicalSpace(logical([["vps",[p]]])),"work");
  setSpacePlacements([space("work"),space("default",true)],[]);
  assert.equal(logicalSpace(logical([["vps",[p]]])),"default");
  assert.equal(deleteTarget([space("work"),space("middle"),space("default",true)],"work").id,"default");
});
test("root-set overlap, remote fallback, local keys, and group distinctions match the existing merge", () => {
  const a=project("a",["a","m"],"host/fork");
  setSpacePlacements([space("work"),space("default",true)],[assignment("mac",a,"work")]);
  assert.equal(logicalSpace(logical([["vps",[project("clone",["m","z"],"host/other")]]])),"work");
  assert.equal(logicalSpace(logical([["vps",[project("shallow",[],"host/fork")]]])),"work");
  assert.equal(logicalSpace(logical([["vps",[project("plain")]]])),"default");
  assert.equal(logicalSpace(logical([["vps",[project("group",[],undefined,{kind:"group",repos:[a.repo]})]]])),"default");
});
test("ambiguous remotes do not attach a shallow checkout to either disjoint root", () => {
  const a=project("a",["a"],"host/repo"),b=project("b",["b"],"host/repo");
  setSpacePlacements([space("one"),space("two"),space("default",true)],[assignment("mac",a,"one"),assignment("pc",b,"two")]);
  assert.equal(logicalSpace(logical([["vps",[project("shallow",[],"host/repo")]]])),"default");
});
test("latest deterministic placement wins after identity refresh and cleared network state does not leak", () => {
  const a=project("a",["a"]),b=project("b",["a"]);
  const row=logical([["mac",[a]],["vps",[b]]]);
  setSpacePlacements([space("one"),space("two"),space("default",true)],[assignment("mac",a,"one",4),assignment("vps",b,"two",5)]);
  assert.equal(logicalSpace(row),"two");
  setSpacePlacements([space("one"),space("default",true)],[]);
  assert.equal(logicalSpace(row),"default");
  setSpacePlacements([]);
});

test("batch resolution considers every actual identity and invalidates when the merged view changes", () => {
  const a=project("a",["a"],"host/repo");
  const shallow=project("shallow",[],"host/repo");
  setSpacePlacements([space("work"),space("default",true)],[assignment("mac",a,"work")]);
  const first=mergeProjects(new Map([["vps",[shallow]]]));
  prepareSpacePlacements(first);assert.equal(logicalSpace(first[0]),"work");
  const b=project("b",["b"],"host/repo");
  const next=mergeProjects(new Map([["vps",[shallow]],["pc",[b]]]));
  prepareSpacePlacements(next);
  assert.equal(logicalSpace(next.find(p=>p.instances.some(i=>i.project===shallow))),"default", "a newly visible disjoint root makes the remote ambiguous without a replica write");
  prepareSpacePlacements(first);assert.equal(logicalSpace(first[0]),"work", "switching back reuses the correct context");
  setSpacePlacements([]);
});

test("free chat remains outside every Space even with a network rail and fallback", () => {
  setSpacePlacements([space("default",true)]);
  const chat=project("00000000-0000-0000-0000-000000000001");
  assert.equal(logicalSpace(logical([["mac",[chat]]]),"default"),null);
  setSpacePlacements([]);
});
