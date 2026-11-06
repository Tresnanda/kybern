# Mobile: every machine on its own, and instant loading — 2026-11

Issues #245 (the phone stops working when the paired Mac is offline) and #248
(threads and data load instantly). This note records what changed on the phone,
how to time it on a device, and what is still unmeasured.

## #245: a thread uses its own machine

- Approvals (`runtime.respondApproval`), terminals (list, subscribe, keystrokes,
  resize, close), workspace actions, Changes/Files, held messages, child threads,
  queued edits and the computer-use live view go to the machine that owns the
  thread (`threadMachine`), never through the paired computer.
- The thread screen reads that machine's connection (`useThreadConnection`): its
  loading, history paging, composer and the reconnect banner. The banner names the
  thread's machine; Try again reconnects that machine (Settings for the paired one).
  The ⋯ menu summary names it as well.
- Another machine's event stream starts when its thread is shown, not only inside a
  load, so it streams while the paired computer is away.
- Spaces, notes and tasks go through the network client: the paired computer while it
  answers, else a live member (`networkClient`, `onNetworkClient`). Notes and tasks ask
  for `machine: "all"` once there are two machines; each item is written on the machine
  that holds it (`federation.sections`, `state/federated.ts`), new items on the machine
  that answers. An away machine's items stay from the offline copy and are read-only.
- Queued prompts of another machine's thread are read from and follow that machine. Project lookups and space counts use the
  merged lists of every machine.
- The empty lists of a fresh connection never replace a machine's cached lists
  before its first refresh (`MachineHub.setPrimaryLists(..., { ready: false })`,
  `primaryListsReady`). This was the "0 projects in every space" bug.
- An away machine's threads, projects, notes and tasks show from the phone's copies,
  greyed or read-only (writes are disabled while it is away).

## #248: what shows before the network answers

| Data | Where it is kept | Bound |
| --- | --- | --- |
| Opened transcripts | `kybern-transcripts.db` (expo-sqlite, `state/transcriptDisk.ts`) | 64 threads / 64 MB LRU, 400 newest rows per thread from a turn start |
| Projects and threads per machine (one machine included) | `kybern-machine-cache.json` (machine set) | 300 threads, 1 MB per machine |
| Notes and tasks of the paired computer | `kybern-list-cache.json` (`state/listCache.ts`) | 500 items, 1 MB per machine, 8 machines |
| Transcripts in memory | `ThreadCache` | 12 threads / 16 MB (page size estimate), open, loading and lingering threads protected |

- Opening a thread with a disk copy draws it on the first frame (no spinner), then
  resumes from its cursor: `events.subscribe { thread_id, after_seq, gap_snapshot }`.
  A small gap replays as events; a large one returns a first page that keeps the
  rows already on screen (`retainHistoryIdentities`). Events of the main stream that
  arrive meanwhile are buffered and replayed after `events.ready`. Machines that have
  not answered a `threads.get` with `as_of_seq` (0.21.6–0.21.8) read the first page
  instead, while the copy stays on screen.
- First pages use `page_budget: FIRST_PAGE_BUDGET` with `transcript_limit: 60` for
  older daemons. A reload that keeps more history than a first page asks for it all,
  as before, so the reading position is kept.
- The thread list: first `threads.list { settled_limit: 25 }`, then
  `threads.list { since_seq }` on activity events, merged by `applyThreadList` (rows
  that did not change keep their objects). "Show more" in a project section pages
  older settled threads in with `settled_offset`. A daemon without `head_seq` gets
  the whole list every time.
- A closed thread lingers in memory for five minutes (`createLinger`); the main event
  stream keeps it current, so reopening it costs nothing.
- The top six rows of the Threads list and Home's "continue" rows prefetch their first
  page, two at a time, skipping threads already current in memory or saved at their
  listed `last_seq` (`createPrefetchQueue`).
- A thread with no copy shows "Loading conversation" only after 400 ms and for at
  least 400 ms (`useSyncIndicator`).

## Timing it on a device (development builds only)

`state/devTiming.ts` records two timings in development builds (`__DEV__`); release
builds do nothing:

- **Open thread**: a tap on a thread row (Threads list, sidebar or Home) to the first
  transcript content the thread screen renders, with the row count and whether a copy
  was already on the phone (`cached`).
- **Cold start**: JavaScript start to the first non-empty thread list, and whether it
  came from the cache or the daemon.

Read them in the Metro console (`[kybern timing] thread 84 ms · 3f2a9c1d · 61 rows ·
cached`) or in the dev kit (`kybern://dev-kit` or `exp://<host>:<port>/--/dev-kit`),
section **Load timings**, newest first.

Workloads to record before and after, on the same device and daemon:

1. Cold start with the paired computer online, then with its daemon stopped.
2. Open a recently seen thread (cached) and one never opened on this phone.
3. Open a long thread (400+ turns) and a thread on another machine (direct and relay).
4. Open a thread that received many events while closed (more than 128 or 1 MB), to
   exercise the gap snapshot.

## Not measured here

No device numbers were taken in this change: it was built and tested on Windows
(TypeScript, the Node test suites, Expo Doctor, iOS and Android exports). The tests
cover routing by owner machine, the network client, the empty-list rule, the SQLite
adapter (fake), eviction, schema mismatch, wipes, cursor resume with a gap snapshot
and buffered events, the list cursor and prefetch bounds. Frame timing, CPU, energy
and the SQLite cost on a real phone remain to be measured with the workloads above.

expo-sqlite is a native module: the installed development app and EAS builds need a
new build (Expo Go for SDK 57 already includes it). An OTA update alone does not add
it; in a build without it the cache stays empty and every open reads the machine as
before.
