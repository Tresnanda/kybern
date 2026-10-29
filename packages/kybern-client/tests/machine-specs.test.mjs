import assert from "node:assert/strict";
import test from "node:test";
import { coresText, harnessChips, machineSpecs, memoryText, osKind, shortCpu, shortGpu, shortVersion, visibleGpus } from "../src/machineSpecs.ts";

const GB = 2 ** 30;

test("processors lose their marketing noise", () => {
  assert.equal(shortCpu("Apple M1"), "Apple M1");
  assert.equal(shortCpu("AMD EPYC"), "AMD EPYC");
  assert.equal(shortCpu("AMD EPYC 9354P 32-Core Processor"), "AMD EPYC 9354P");
  assert.equal(shortCpu("Intel(R) Xeon(R) Platinum 8255C CPU @ 2.50GHz"), "Xeon Platinum 8255C");
  assert.equal(shortCpu("AMD Ryzen 7 5800H with Radeon Graphics"), "Ryzen 7 5800H");
  assert.equal(shortCpu("11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz"), "Core i7-1165G7");
  assert.equal(shortCpu(""), null);
  assert.equal(shortCpu(undefined), null);
});

test("graphics cards get short names and virtual adapters vanish", () => {
  assert.equal(shortGpu("NVIDIA GeForce RTX 3060 Laptop GPU"), "RTX 3060 Laptop");
  assert.equal(shortGpu("AMD Radeon(TM) Graphics"), "Radeon");
  assert.equal(shortGpu("Intel(R) UHD Graphics 630"), "UHD 630");
  assert.equal(shortGpu("Cirrus Logic GD 5446"), null);
  assert.equal(shortGpu("Microsoft Basic Display Adapter"), null);
  assert.equal(shortGpu("llvmpipe (LLVM 15.0.7, 256 bits)"), null);
  assert.equal(shortGpu("Apple M1"), "Apple M1");
});

test("a Mac's GPU that is its CPU is hidden; real ones are listed once", () => {
  assert.deepEqual(visibleGpus(["Apple M1"], "Apple M1"), []);
  assert.deepEqual(visibleGpus(["Apple M2 Pro"], "Apple M2 Pro"), []);
  assert.deepEqual(visibleGpus(["Cirrus Logic GD 5446"], "Intel(R) Xeon(R) Platinum 8255C CPU @ 2.50GHz"), []);
  assert.deepEqual(visibleGpus(["NVIDIA GeForce RTX 3060 Laptop GPU", "AMD Radeon(TM) Graphics"], "AMD Ryzen 7 5800H with Radeon Graphics"), ["RTX 3060 Laptop", "Radeon"]);
  assert.deepEqual(visibleGpus(["AMD Radeon(TM) Graphics", "AMD Radeon Graphics"]), ["Radeon"]);
  assert.deepEqual(visibleGpus(undefined), []);
});

test("memory, cores and the OS family", () => {
  assert.equal(memoryText(16 * GB), "16 GB");
  assert.equal(memoryText(0), null);
  assert.equal(coresText(16), "16 cores");
  assert.equal(coresText(1), "1 core");
  assert.equal(coresText(undefined), null);
  assert.equal(osKind("macOS"), "macos");
  assert.equal(osKind("Darwin"), "macos");
  assert.equal(osKind("windows"), "windows");
  assert.equal(osKind("Linux"), "linux");
  assert.equal(osKind("freebsd"), null);
});

test("the five machines of the network, as the screenshot reported them", () => {
  assert.deepEqual(machineSpecs({ cpu: { model: "Apple M1", logical_cores: 8 }, gpu: ["Apple M1"], mem: { total_bytes: 16 * GB } }), { cpu: "Apple M1", cores: "8 cores", memory: "16 GB", gpus: [] });
  assert.deepEqual(machineSpecs({ cpu: { model: "AMD EPYC", logical_cores: 4 }, gpu: [], mem: { total_bytes: 8 * GB } }), { cpu: "AMD EPYC", cores: "4 cores", memory: "8 GB", gpus: [] });
  assert.deepEqual(machineSpecs({ cpu: { model: "AMD EPYC 9354P 32-Core Processor", logical_cores: 2 }, mem: { total_bytes: 8 * GB } }), { cpu: "AMD EPYC 9354P", cores: "2 cores", memory: "8 GB", gpus: [] });
  assert.deepEqual(machineSpecs({ cpu: { model: "Intel(R) Xeon(R) Platinum 8255C CPU @ 2.50GHz", logical_cores: 2 }, gpu: ["Cirrus Logic GD 5446"], mem: { total_bytes: 2 * GB } }), { cpu: "Xeon Platinum 8255C", cores: "2 cores", memory: "2 GB", gpus: [] });
  assert.deepEqual(machineSpecs({ cpu: { model: "AMD Ryzen 7 5800H with Radeon Graphics", logical_cores: 16 }, gpu: ["NVIDIA GeForce RTX 3060 Laptop GPU", "AMD Radeon(TM) Graphics"], mem: { total_bytes: 15 * GB } }), { cpu: "Ryzen 7 5800H", cores: "16 cores", memory: "15 GB", gpus: ["RTX 3060 Laptop", "Radeon"] });
  assert.deepEqual(machineSpecs(false), { cpu: null, cores: null, memory: null, gpus: [] });
});

test("a harness version is its first dotted number", () => {
  assert.equal(shortVersion("2.1.312 (Claude Code)"), "2.1.312");
  assert.equal(shortVersion("codex-cli 0.165.0"), "0.165.0");
  assert.equal(shortVersion("omp/18.13.2"), "18.13.2");
  assert.equal(shortVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(shortVersion("nightly"), "nightly");
  assert.equal(shortVersion(""), null);
});

test("harness chips list only what is installed", () => {
  assert.deepEqual(
    harnessChips([
      { kind: "claude-code", available: true, version: "2.1.284 (Claude Code)", signed_in: true },
      { kind: "codex", available: true, version: "codex-cli 0.165.0" },
      { kind: "opencode", available: false },
      { kind: "pi", available: false },
      { kind: "omp", available: true, version: "omp/18.13.2", signed_in: false },
      { kind: "cursor", available: false },
    ]),
    [
      { kind: "claude-code", label: "Claude 2.1.284", signedOut: false },
      { kind: "codex", label: "Codex 0.165.0", signedOut: false },
      { kind: "omp", label: "omp 18.13.2", signedOut: false },
    ],
  );
  assert.deepEqual(harnessChips([{ kind: "codex", available: false }]), []);
  assert.deepEqual(harnessChips(undefined), []);
  assert.deepEqual(harnessChips([{ kind: "pi", available: true }]), [{ kind: "pi", label: "pi", signedOut: false }]);
});
