# Motion check harness (desktop chat)

An offline, reusable setup for looking at motion in the desktop frontend without the Tauri app: a
scratch `kybernd` whose Claude provider is a fixture driver, a seed for the chat scenes, and a
headless-WebKit probe that records every animation an interaction starts. Nothing here touches
`~/.kybern` or a running Kybern.

## Run it

```sh
export DATA=/path/to/scratch-dir            # default /tmp/kybern-motion-scratch
export OUT=/path/for/screenshots            # default $DATA/shots
cd apps/desktop
pnpm install --frozen-lockfile              # once
perf/motion/scratch.sh up                   # daemon on :4368, Vite on :5368 (prints the app URL)
perf/motion/seed.sh                         # chat scenes, see below (~20 s)
python3 perf/motion/seed-long.py "$DATA"    # optional: a 150-turn thread for streaming/scroll work
node perf/motion/scenario-send.mjs          # SCHEME=light|dark REDUCED=1 where it applies
perf/motion/scratch.sh down                 # stops both and deletes $DATA
```

Environment: `PORT` / `VITE_PORT` pick the ports, `KYBERND` / `KYBERN_CLI` the binaries (default: the
installed app's), `PLAYWRIGHT_CORE` the path of `playwright-core/index.mjs`. Vite is started with
`env -u NAPI_RS_NATIVE_LIBRARY_PATH` because that variable breaks the desktop Vite build.

## What is seeded (`seed.sh`, driver: `fake-claude-driver.py`)

The prompt's `SCENE_*` keyword picks the scene; every thread uses the project at `$DATA/project`.

| Thread | State | Scene |
| --- | --- | --- |
| Fix the retry loop | settled | thinking, Read/Grep/Bash/Edit/Write/TodoWrite, answer with list, table, code, edited-files card |
| Explain the retry design | settled | long answer: table, code, Mermaid fence, an inline visual reply (`visual-fixture.html`) |
| SCENE_FAIL … | failed | tool error, then an API error turn |
| Audit slow queries … | settled | a native Claude subagent that works, then completes (subagent child thread) |
| Split scene delegate … | settled | two `kybern_agent_delegate` calls (delegation group row; children are not real threads) |
| SCENE_APPROVAL … | awaiting approval | Bash permission |
| SCENE_QUESTION … | awaiting input | `AskUserQuestion` |
| SCENE_LIVE … | running | one slow word every 0.6 s, stays running |

`SCENE_STREAM` (not seeded) is a fast ~25 s stream with tables and code: send it to the long thread
for the streaming/scroll workload (`measure-stream-scroll.mjs`).

## Probes

- `probe-lib.mjs`: `open()`, `thread()`, `probe()` (what animated: target, property, duration,
  easing), `scrub()` (frame strip: pauses every animation as it starts and screenshots at 20/50/80 % of
  each), `frames()` (frame intervals, long tasks, peak animation count), `runningAnimations()`.
  Headless screenshots are too slow to catch a 250 ms motion at 60 ms; use `scrub()` for the middle.
- `scenario-send.mjs`: send (editor clears at accept, send ↔ stop swap, queue chips), then the settle
  chrome of the turn.
- `scenario-panels.mjs`: approval and question cards in and out, question steps, model picker, the
  scroll-to-bottom button.
- `scenario-rest.mjs`: queue rows, visual reply zoom, image lightbox, delegation and subagent rows.
- `scenario-scrub.mjs`: frame strips for the visual and lightbox zooms.
- `measure-stream-scroll.mjs`: one frontend (`VITE_PORT`), streaming then scrolling on the long thread;
  run it against a baseline checkout's Vite and this one, interleaved, for before/after.
  `LONG=<thread id>` is required.

Approval and question scenes are consumed when answered: create fresh threads with
`kybern --data-dir "$DATA" new -p "$DATA/project" --mode supervised --detach "SCENE_APPROVAL again"`
before re-running `scenario-panels.mjs`.
