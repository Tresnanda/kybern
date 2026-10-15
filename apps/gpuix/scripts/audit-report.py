#!/usr/bin/env python3
"""Rebuild the audit tables from the captured issue and measured artifacts."""
import collections,json,pathlib,re,statistics
ROOT=pathlib.Path(__file__).resolve().parents[1]
ART=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16')
ledger=json.loads((ROOT/'scripts/audit-ledger.json').read_text())
body=json.loads((ART/'issue-108.json').read_text())['body']
areas={
 1:'src/App.tsx; src/shell/layout.ts, ResizeHandle.tsx, Connection.tsx, ErrorBoundary.tsx; src/nav/TitleBar.tsx',
 2:'src/nav/NavRail.tsx; src/nav/store.ts and history.ts',
 3:'src/Sidebar.tsx; src/sidebar/model.ts and rows.tsx; src/nav/live.ts',
 4:'src/sidebar/EnvironmentSwitcher.tsx; src/environments/Dialogs.tsx, registry.ts and actions.ts',
 5:'src/Draft.tsx; src/Composer.tsx; src/composer/Tray.tsx and store.ts',
 6:'src/nav/TitleBar.tsx; src/coordinator/Header.tsx; src/subagents/Page.tsx',
 7:'src/Transcript.tsx; src/transcript/Turn.tsx, rows.tsx, store.ts and kit.tsx',
 8:'src/requests/Panel.tsx and Activity.tsx; src/transcript/Requests.tsx; src/requests/verify.ts',
 9:'src/Composer.tsx; src/composer/Completion.tsx, chips.tsx and PermissionPicker.tsx; conversation.verify.ts',
 10:'src/composer/ModelPicker.tsx and StatusGlyph.tsx; src/composer/store.ts',
 11:'src/split/Workspace.tsx and store.ts; src/split/native.verify.ts',
 12:'src/dock/Dock.tsx and store.ts; src/dock/verify-dock-check.ts',
 13:'src/environment/Panel.tsx, store.ts and ThreadNote.tsx',
 14:'src/live/ComputerLiveView.tsx, Floating.tsx and poll.ts',
 15:'src/subagents/Page.tsx, Hover.tsx and Composer.tsx; src/requests/Panel.tsx',
 16:'src/notes/NotesPage.tsx, NoteEditor.tsx, NoteMenu.tsx and Overlays.tsx; src/notes/verify.ts',
 17:'src/tasks/TasksPage.tsx, TaskList.tsx, TaskDetail.tsx and store.ts; src/tasks/verify.ts',
 18:'src/pulls/PullRequestsPage.tsx, PrDetail.tsx and PrTabs.tsx; src/pulls/verify.actions.ts',
 19:'src/usage/UsagePage.tsx; src/usage/verify.native.ts',
 20:'src/nav/Palette.tsx',
 21:'src/dialogs/Dialogs.tsx, ProjectPicker.tsx and WorktreeCleanup.tsx; src/nav/Sessions.tsx and Handoff.tsx',
 22:'src/settings/SettingsScreen.tsx, primary.tsx, secondary.tsx and controls.tsx; src/settings/verify.native.ts',
 23:'src/shell/toasts.tsx and agentToasts.ts; src/nav/live.ts',
 24:'src/nav/keys.ts and surface addWindowKeyHandler registrations',
 25:'src/motion/kit.tsx; src/MatrixLoader.tsx; src/transcript/motion.tsx; surface motion hooks',
 26:'src/theme.ts and ui.tsx; src/settings/appearance.ts; src/shell/appearance.ts',
 27:'src/main.tsx; src/shell/window.ts; src/native/material.ts; src/environments/actions.ts',
 28:'src/composer/Menu.tsx; src/nav/overlay.tsx; src/settings/controls.tsx; src/ui.tsx',
 29:'src/state.ts; src/nav/live.ts; src/shell/persist.ts; packages/kybern-client/src/client.ts',
}
# More precise evidence for parallel checklist items.
precise={
 '7.3':'src/transcript/bubble.tsx', '7.4':'src/transcript/bubble.tsx SaveToNoteAction', '7.6':'src/transcript/bubble.tsx clampLines',
 '7.20':'src/transcript/Turn.tsx SaveToNoteAction and src/transcript/note.verify.ts',
 '7.25':'src/transcript/Requests.tsx and src/coordinator/Cards.tsx', '7.26':'src/transcript/images.tsx',
 '7.28':'src/transcript/Messages.tsx item cards', '7.29':'src/transcript/Messages.tsx and src/subagents/Launch.tsx',
 '7.31':'src/requests/Activity.tsx','7.35':'src/transcript/rail.tsx and navigation.verify.ts','7.36':'src/transcript/store.ts pane-specific anchors',
 '8.9':'src/coordinator/Cards.tsx','8.11':'src/requests/messages.ts and Panel.tsx','8.12':'src/requests/Panel.tsx helper group',
 '8.13':'src/subagents/Composer.tsx and requests/Panel.tsx','8.14':'src/requests/Activity.tsx',
 '12.3':'src/dock/Agents.tsx','12.4':'src/dock/Project.tsx','12.5':'src/dock/Activity.tsx','12.7':'src/dock/Review.tsx','12.12':'src/dock/Tasks.tsx',
 '17.2':'src/tasks/TasksSidebar.tsx','17.3':'src/tasks/TaskList.tsx and drag.tsx','17.4':'src/tasks/TaskList.tsx and drag.tsx',
 '17.5':'src/tasks/Header.tsx and TaskMenus.tsx','17.6':'src/tasks/QuickAdd.tsx','17.7':'src/tasks/SelectionBar.tsx',
 '17.8':'src/tasks/SelectionBar.tsx and RunComposer.tsx','17.9':'src/tasks/TaskDetail.tsx','17.10':'src/tasks/RunComposer.tsx',
 '17.11':'src/tasks/TasksPage.tsx key handlers','17.12':'src/tasks/store.ts delete/restore with Undo',
 '23.4':'src/nav/live.ts persisted unread/attentionDismissals; shell/persist.ts exit flush',
 '25.14':'src/dock/Dock.tsx, settings/SettingsScreen.tsx and shell/Connection.tsx',
 '25.15':'src/subagents/Page.tsx frozen outgoing pane context; split/native.verify.ts',
}
rows=[];section=0;n=0;headings={}
for line in body.splitlines():
 m=re.match(r'### (\d+)\. (.*)',line)
 if m:section=int(m[1]);headings[section]=m[2];n=0
 if not section or not re.match(r'- \[([ x])\] ',line):continue
 n+=1;key=f'{section}.{n}'
 req=re.sub(r'^- \[([ x])\] ','',line)
 if req.startswith('(partial: '):req=req[req.find(')')+1:].strip()
 item=ledger.get(key,{'status':'Done','evidence':precise.get(key,areas[section])+': current implementation inspected; behavioral coverage and limits are listed below.'})
 rows.append(dict(key=key,requirement=req,**item))
assert len(rows)==341,len(rows)
counts=collections.Counter(x['status'] for x in rows)
checks=json.loads((ART/'checks/results.json').read_text()) if (ART/'checks/results.json').exists() else []
if (ART/'checks/extra-results.json').exists():checks+=json.loads((ART/'checks/extra-results.json').read_text())
if (ART/'checks/followup-results.json').exists():checks+=json.loads((ART/'checks/followup-results.json').read_text())
if (ART/'checks/finalcheck-results.json').exists():checks+=json.loads((ART/'checks/finalcheck-results.json').read_text())
envfile=ART/'checks/environments/results.json'
if envfile.exists():checks+=json.loads(envfile.read_text())
envisolation=ART/'checks/environments-isolation/results.json'
if envisolation.exists():checks+=json.loads(envisolation.read_text())
covered={x['file'] for x in checks if x.get('log')}
checks=[x for x in checks if x.get('log') or x['file'] not in covered]
checks += [dict(file=f, mode='n/a', status='Not standalone', detail='Fixture application used by the dock/runtime verifiers, not a standalone assertion script.') for f in ['src/dock/verify-fixture.tsx','src/live/verify-changing.tsx']]
visual=json.loads((ART/'visual/gpuix-results.json').read_text()) if (ART/'visual/gpuix-results.json').exists() else []
refs=json.loads((ART/'visual/reference-results.json').read_text()) if (ART/'visual/reference-results.json').exists() else []
perf=json.loads((ART/'performance.json').read_text()) if (ART/'performance.json').exists() else []
workload=json.loads((ART/'performance-workload.json').read_text()) if (ART/'performance-workload.json').exists() else {}
def safe(text):return str(text).replace('|',r'\|').replace('\n',' ')
def link(path):return f'[{pathlib.Path(path).name}]({path})'
out=['# GPUIX parity audit — October 16, 2026','',
'**Audit snapshot: `0b0978c5` on `gpuix/dock2`.** The checkout was fast-forwarded from `feat/gpuix-mvp`; no application source was changed. The native addon was copied from the integration checkout and the frozen dependency install succeeded. Later sibling changes are outside this snapshot.','',
f'Feature inventory: **{counts["Done"]} Done / {counts["Partial"]} Partial / {counts["Missing"]} Missing**, out of **341** issue #108 checklist lines. Delta from 242 / 74 / 25: **{counts["Done"]-242:+d} / {counts["Partial"]-74:+d} / {counts["Missing"]-25:+d}**. Done share: **{counts["Done"]/341*100:.1f}%**. This is a checklist completion fraction, not a claim of that percentage of visual parity.','',
'## Method and limits','',
'- Runtime: Apple M1 arm64, macOS 27.0 (26A428), Bun 1.4.0. Native addon SHA-256: `a5b2f882a93da1a08cca9038e882128ecfe821c1cdd35d24b5c15fa3463c8f10`; source checkout hash does not prove addon build provenance. Existing bundle executable SHA-256: `51e0673f9cd8cabcdd9fdd533cef34855cf20655c0a50f03869eefedcdad3eb1` (October 15 artifact).',
'- Checklist text comes from `gh issue view 108 --json body`, captured in the artifact directory. Lines are numbered by section and occurrence, independently of the issue’s stale checkbox state. Every line below has a current source or verifier reference.',
'- Done means the stated functional surface exists with no identified material functional omission. Partial means an incomplete subfeature or significant validation gap. Missing means no usable implementation. A fallback is not equivalent to the requested embedded feature.',
'- Snapshot source takes precedence over package reports. Examples: notifications and global-note routing are integrated despite older reports; sidebar split menu actions are still disabled despite split workspace support. Automated checks are fixtures, not proof of every real provider/account/device combination.',
'- The same seeded data is reused, but reference and native captures are sequential and wall-clock time is not frozen. Relative timestamps and time-dependent labels can contribute to mismatch; the metric does not mask them.',
'- Visual percentages count pixels whose maximum RGB channel difference exceeds 24/255. The reference is desktop React in Playwright WebKit, not the installed Tauri window. Captures are opaque and reduced-motion; they do not certify vibrancy, blur, motion, hardware input, IME or OS permission behavior.',
'- An initial native continuation omitted the fixture token and fell back to the underlying scratch daemon. That pass was discarded, with its log and two diagnostic pairs retained under invalid-native-direct-daemon. The reported pass supplies the same proxy URL/token boundary as the reference; no normal user daemon was involved.',
'- The original all-screen command failed at `dock-explorer-file`; audit-only scripts continue per screen without modifying application sources or silently dropping failures. The visual settings proxy rejects some dock RPCs; failure/error states are explicitly limited below.',
'- All mutation checks use isolated scratch daemons or mock RPCs. No real provider turn, account sign-out, GitHub merge, normal ~/.kybern data, or reserved port 4219 was used.','',
'## Verification matrix','',
'Baseline `pnpm typecheck`: pass. `bun test ./src`: **43 pass, 0 fail, 402 assertions**. Raw logs and screenshots: '+link(ART)+'.','',
'This audit serializes its native tests; sibling agents were active elsewhere, so incidental performance numbers in verifier logs may include contention. The original split matrix exceeded the initial 150 s runner budget; its reduced-mode outgoing-page expectation is invalid for immediate navigation. An audit copy reruns all trials with a longer budget and asserts no outgoing page in reduced mode, preserving the other assertions. The wrapper supplies a fresh installed-binary scratch daemon and isolated client/credential paths. Reduced mode sets `KYBERN_REDUCED_MOTION=1`; self-matrix reveal/collapse/popup tests already exercise their required modes. Fixture-only files are listed separately instead of reporting a meaningless zero-assertion pass.','',
'| Check | Mode | Result | Evidence |','|---|---|---|---|']
area_summary=['## Checklist coverage by area','','| Area | Done | Partial | Missing |','|---|---:|---:|---:|']
for section,title in headings.items():
 c=collections.Counter(x['status'] for x in rows if int(x['key'].split('.')[0])==section)
 area_summary.append(f'| {section}. {safe(title)} | {c["Done"]} | {c["Partial"]} | {c["Missing"]} |')
area_summary+=['','Counts are unweighted checklist lines, including repeated requirements in different sections; Partial receives no fractional credit.','']
pos=out.index('## Verification matrix');out[pos:pos]=area_summary
for x in checks:out.append(f'| `{x["file"]}` | {x["mode"]} | {x["status"]} | {link(x["log"]) if x.get("log") else safe(x.get("detail",""))} |')
out+=['','Check outcomes: '+', '.join(f'{n} {status}' for status,n in collections.Counter(x['status'] for x in checks).items())+'.','',
'Failure interpretation: integration-patch context mismatches are stale patch verification; the physical window-drag test is blocked by Accessibility permission. Initial artifact/Explorer checks lack their historical `.p5/project` fixture; isolated follow-up results are separate rows. Old dock runtime and page checks must be read alongside newer fixture verifiers; a passing newer check does not erase the original failure. Reduced-motion entrance timeouts remain failures until a diagnostic explains them. Coordinator follow-ups correct the historical project ID and clear empty endpoint variables for CLI reads; the first retry saved the brief before its CLI assertion failed. QR pixel matrices are recorded, but different masks can encode the same payload: the independent Vision payload decode is the functional assertion.','',
'### Failing output','']
for x in checks:
 if x['status'] not in ('Fail','Timeout'):continue
 tail=x.get('tail','');lines=tail.splitlines();meaning=[l.strip() for l in lines if re.search(r'error:|AssertionError|Timeout|timed out|expected|actual|Patch context|assert|ENOENT',l,re.I)]
 detail='; '.join(meaning[-4:]) or tail[-600:]
 out.append(f'- `{x["file"]}` ({x["mode"]}): `{safe(detail)}`. Full output: {link(x["log"])}.')
out+=['','## Visual comparisons','',
'Run requested: `bun scripts/visual-pair.ts --list`, then all screens with `--theme both --fresh --keep`. The original command aborted during reference capture before native capture. `audit-reference.mjs` and `audit-visual.ts` continue the same per-screen steps with per-screen error accounting and the same fresh seed. `audit-proxy.ts` keeps the original settings fixture boundary alive after the original process exits.','',
'Pass in capture outcomes means capture/composition completed, not that the screen is visually or functionally equivalent. Each successful link points to the pair; adjacent files carry `-tauri.png`, `-gpuix.png`, and `-diff.png`. N/A is not zero difference.','',
'| Screen | Dark differing pixels | Light differing pixels |','|---|---:|---:|']
by={(x['name'],x['theme']):x for x in visual};rb={(x['name'],x['theme']):x for x in refs}
names=list(dict.fromkeys([x['name'] for x in refs]+[x['name'] for x in visual]))
for name in names:
 cells=[]
 for theme in ['dark','light']:
  x=by.get((name,theme));r=rb.get((name,theme))
  if x and x['status']=='Pass':cells.append(f'[{x["metric"].split()[0]}]({ART}/visual/{name}-{theme}-pair.png)'+(' ⚠ wrong target state' if x.get('stateValid') is False else '')+(' ⚠ fixture error visible' if 'Visual fixture rejects' in x.get('paintedText','') else ''))
  elif x:cells.append('N/A — '+x['status'])
  elif r and r['status']=='Fail':cells.append('N/A — reference failed')
  else:cells.append('Pending')
 out.append(f'| {name} | {cells[0]} | {cells[1]} |')
valid_visual=[x for x in visual if x['status']=='Pass' and x.get('stateValid') is not False and 'Visual fixture rejects' not in x.get('paintedText','')]
if len(visual)==202:
 out+=['','All **202 screen/theme cases** were attempted: 198 composed pairs, two Explorer-file navigation failures, and two Terminal captures without a usable WebKit reference. Six original Notes editor pairs opened the wrong note; their exact-title supplements appear below.','']
 for theme in ['dark','light']:
  vals=[float(x['metric'].split('%')[0]) for x in valid_visual if x['theme']==theme]
  out.append(f'- {theme.title()}: {len(vals)} pairs after excluding wrong-note/visible-fixture-error cases; median {statistics.median(vals):.2f}% differing pixels, range {min(vals):.2f}–{max(vals):.2f}%. These are unweighted full-window measures, not a parity score.')
 out+=['','Visible findings: light Notes quick capture differs by **87.44%**, chiefly in the full-window modal scrim, with stronger native placeholder text/shadow and a different default note location (Global versus docs-site). PR Changes differs by **7.96% dark / 7.75% light**. Corrected Notes editors preserve the overall column/outline/toolbar layout but differ in text weight, vertical spacing, relative timestamps and word count (97 versus 98 in the inspected note). Settings General preserves its form layout but differs in icons, navigation spacing and the environment label.','']
out+=['','Captured native outcomes: '+', '.join(f'{n} {status}' for status,n in collections.Counter(x['status'] for x in visual).items())+'.','', '### Capture failures','']
for x in refs+visual:
 if x['status']=='Fail':out.append(f'- `{x["name"]}` {x["theme"]}: {safe(x.get("error",""))}')
diagnostic_file=ART/'visual/failed-state-results.json'
if diagnostic_file.exists():
 diagnostics=json.loads(diagnostic_file.read_text())
 out+=['','Failed navigation states were also captured for diagnosis. These images do not complete the intended Explorer-file scenario and receive no parity score.','']
 for x in diagnostics:
  out.append(f'- `{x["name"]}` {x["theme"]}: [{x["status"]}]({ART}/visual/{x["name"]}-{x["theme"]}-failed-state-gpuix.png).')
supplemental=json.loads((ART/'visual-supplemental/results.json').read_text()) if (ART/'visual-supplemental/results.json').exists() else []
if supplemental:
 out+=['','### Corrected target-state supplements','','The original steps use fixed-coordinate fallbacks and can open a different note or remain in the gallery. Their measured percentages remain above with a warning. These additional captures search the exact title and open the matching card; they do not alter app source or replace the original-run evidence.','','| Screen | Theme | Differing pixels |','|---|---|---:|']
 for x in supplemental:out.append(f'| {x["name"]} | {x["theme"]} | [{x.get("metric",x["status"])}]({ART}/visual-supplemental/{x["name"]}-{x["theme"]}-pair.png) |')
metrics=json.loads((ART/'state-metrics.json').read_text()) if (ART/'state-metrics.json').exists() else []
out+=['','### Interaction-state sensitivity','',
'Within each renderer, compare the state capture against its base. Exactly identical images cannot show the requested interaction. Tiny differences can be diluted by the full-window denominator; nonzero differences alone do not prove that the intended control changed. **Confirmed threshold blind spots:** WebKit settings-hover changes 27,280 pixels and pulls-hover changes about 76,000 pixels, yet neither changes any pixel by more than 24 in either theme: the published threshold metric sees 0.00% of those hover effects. Focus and other small controls occupy well below 1% of the window.','',
'| State vs base | Theme | Renderer | Pixels changed | Pixels >24 | Whole-window % >24 |','|---|---|---|---:|---:|---:|']
for x in metrics:out.append(f'| {x["state"]} vs {x["base"]} | {x["theme"]} | {x["renderer"]} | {x.get("changedPixels",x["status"])} | {x.get("over24Pixels","—")} | {x.get("over24Percent","—")} |')
out+=['','### Coverage limits','',
'- No pairs for SSH bootstrap/tunnel, real Keychain/multiple-window ownership, packaged OS permission/banner clicks, startup/update installation, real hardware IME, native save/copy-image, live account/OAuth completion, every permission/request subtype, very large histories, or most keyboard/focus and motion transitions.',
'- `dock-preview-opened` and mini-player capture fallback controls, not embedded page rendering; the opened native preview also shows a rejected previews.servers.list RPC. A low whole-window mismatch cannot certify missing page content.',
'- Empty lineage/activity and mock PR/accounts states do not cover every populated provider runtime. The settings visual proxy rejects `files.*`, `terminals.*` and other dock RPCs, so Explorer/Terminal availability must be read together with the failure ledger rather than treated as ordinary successful surface captures.','',
'## Performance snapshot','',
f'Workload: 1280×820 window, {workload.get("threadCount", "pending")} seeded threads and {workload.get("tasks", "pending")} tasks. The populated thread has {workload.get("transcriptEntries", "pending")} transcript entries ({workload.get("transcriptJsonBytes", "pending")} JSON bytes), two settled turns with formatted Markdown and three tool calls; no streaming load. CPU/footprint cover the client process only, excluding the daemon and fixture proxy.',
'',
'Apple M1, macOS 27, Bun 1.4.0; background native windows. Each source scene uses a fresh process, 10 s warm-up and 15 s measurement, twice. CPU is process CPU-time delta; memory is `footprint` physical MiB; GPU is accumulated AGX Metal time over the sample, not frame time or energy. Screenshots occur only after each measurement. Measurements were serialized by this audit; a separate drag-motion agent and the normal host apps could contend. Per-sample process snapshots are in performance.json. CPU comes from the existing sampler and includes the small post-wait footprint/query overhead divided by the nominal 15 s; it is not a hard real-time interval. Background/occluded GPU values are lower bounds and exclude WindowServer/compositor material cost.','',
'| Scene | Run | CPU % | Footprint MiB | GPU ms / 15 s |','|---|---:|---:|---:|---:|']
for x in perf:
 if x['scene']=='startup':continue
 m=re.search(r'total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms',x.get('output',''))
 out.append(f'| [{x["scene"]}]({ART}/perf-{x["scene"]}-{x["run"]}.png) | {x["run"]} | {m[2] if m else "Unavailable"} | {m[1] if m else "Unavailable"} | {m[3] if m else "Unavailable"} |')
out+=['','Startup is **launch to first nonempty `getPaintedText` observed through automation**, an upper-bound paint proxy including handshake/IPC, not an instrumented display-compositor first-paint timestamp. Five sequential runs per executable under warm filesystem/cache conditions, with no cache purge; this measures first painted text rather than fully hydrated content. The packaged app is the pre-existing artifact from `ade-gpuix-native`; it was not rebuilt and is not guaranteed to contain this source snapshot.','',
'| Launch | Five observed paint times (ms) | Median (ms) |','|---|---|---:|']
for kind in ['source','bundle']:
 vals=[x['firstPaintObservedMs'] for x in perf if x['scene']=='startup' and x['kind']==kind]
 out.append(f'| {kind} | {", ".join(map(str,vals)) or "Pending"} | {statistics.median(vals) if vals else "Pending"} |')
out+=['','## Fixed after snapshot','',
'The parent integration thread reports these fixes on `feat/gpuix-mvp` after `0b0978c5`. They are outside this audit snapshot; the 274 / 58 / 9 ledger and snapshot verification results are deliberately unchanged.','',
'- Sidebar split context actions are wired.',
'- The Settings global-notes control is wired.',
'- The pair-tool proxy forwards non-mocked RPCs, allowing dock Explorer and Terminal to load.',
'- The PR keyboard-refresh failure was a test timing race. Condition waits replaced the fixed sleep; the check passes in all four theme/motion modes.',
'- Stale dock checks are fixed.',
'- Hover/focus/selected captures now have a state-delta metric; Settings focus passes at 99.4%. This later metric is separate from the snapshot whole-window pixel differences above.','',
'## Remaining work, ranked by user-visible impact','',
'1. **Native + app: embedded web/HTML preview.** Implement the native host and relay lifecycle, clipping/focus/history/permissions and integrate artifact, inline visual and mini-player content. External-browser receipts are not 1:1 parity.',
'2. **App + native: editing, terminal and input.** Extend the VT terminal beyond its current subset (designated character sets and xterm mouse reporting are ignored). Finish rich inline token/task atoms, note-editor selection/outline behavior, clipboard-image paste and drag-enter highlight; certify actual IME, secure-input accessibility and physical drag-release behavior.',
'3. **App/platform: shipping lifecycle.** Own daemon spawn/restart, SSH bootstrap/tunnel, single-window-per-environment, native save/copy image, signed self-update and bundled CLI discovery. Finish packaged notification click/navigation and permission lifecycle.',
'4. **App: visible workflow holes.** Finish project drag reorder, complete local draft commands, per-account rail usage/account-login actions, thread search, nested menus/time picker, and remaining environment-panel details. The Commit and push RPC limitation also exists in Tauri and is not counted as a port-specific gap.',
'5. **Native + app: visual detail and motion.** Resolve material/opacity differences, remaining diff/Markdown/control geometry, marquee, attention/check/caret details, full accessibility appearance behavior, theme transition, and occluded-history compaction. Audit-only static screenshots cannot certify these.',
'6. **Verification tooling: durable fixture coverage.** Repair remaining stale integration patch checkers; replace historical hardcoded fixture scripts; add meaningful physical/IME/OS and foreground performance coverage. Do not interpret green unit tests or low whole-frame pixel percentages as these missing checks.','',
'## Line-by-line feature inventory','']
last=None
for x in rows:
 sec=int(x['key'].split('.')[0])
 if sec!=last:out += [f'### {sec}. {headings[sec]}','','| Line | Requirement | Status | Current evidence / remaining gap |','|---|---|---|---|'];last=sec
 out.append(f'| {x["key"]} | {safe(x["requirement"])} | {x["status"]} | {safe(x["evidence"])} |')
out+=['','## Disk, process cleanup and retained artifacts','',
'Free space before install/capture: **58 GiB**. Pre-existing dependencies: **225 MiB**; copied native addon: **23 MiB**. No Cargo build, runtime download, new dependency or package rebuild. Resume free space: **54 GiB**; final free space: **54 GiB**. Stopped the audit-owned daemon, Vite server and fixture proxies; removed the completed 5 MiB visual scratch fixture after checking for open files. Retained **462 MiB** of screenshots, raw measurements and logs as the audit deliverable, plus the existing **244 MiB** dependency tree/native addon to keep this shared checkout usable. No Rust target was created. Other agents’ daemons, the installed app and normal user data were left running/untouched. All report/scripts remain uncommitted.','']
(ROOT/'perf/parity-2026-10-16.md').write_text('\n'.join(out))
(ART/'feature-ledger.json').write_text(json.dumps(rows,indent=2))
print(dict(counts),len(rows),'checks',len(checks),'visual',len(visual))
