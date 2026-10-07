# Changelog

## 0.7.1

<!-- kybern-release-title: A clearer pull request workspace -->
<!-- kybern-release-summary: Keep the PR list beside your review, read changes and discussion separately, and keep agent timers readable. -->

- Keep the pull request list beside the selected review in wide windows, with Overview, Changes and Conversation tabs. Description, checks and reviewers appear in the overview; changed files have their own rail. Narrow windows keep the back action, search and selected-row focus. Review drafts and verified checkout before agent repairs are preserved.
- Keep subagent elapsed times on one line, including long-running tasks. Long titles leave room for status and controls; background status moves to its own line when larger text or a narrow pane needs more space.
- Make inline HTML preview and publication available to Pi, Oh My Pi and dedicated project coordinators. Agents can choose visual replies when they help, without a special prompt.
- Refresh Kybern's guidance when resuming or importing a Cursor conversation, so it describes the currently available tools.

## 0.7.0

<!-- kybern-release-title: Keep working across accounts and agents -->
<!-- kybern-release-summary: Switch accounts in the same conversation, review pull requests in Kybern, and let agents reply with interactive visuals. -->

- Add named accounts for every harness, with global defaults, project overrides, and a choice for each conversation. Switching keeps the conversation, drafts, files, tasks, and checkout together. Compatible native sessions resume; a fresh session receives saved conversation context. When a confirmed 5-hour or weekly limit interrupts work, choose another account and continue explicitly.
- Switch harnesses in the same conversation. Queued messages keep the harness and account selected when they were queued, and background services keep their original owner and controls.
- Message a running Claude subagent from its normal composer. Messages wait for that child's next tool call and show confirmed delivery. If it finishes first, the original message stays available with an explicit Send to parent action. Native subagent rows use their harness logos.
- Review pull requests in Kybern's full page or right dock, with files, checks, review comments, saved drafts, inline comments, checkout, and explicit review and merge actions. Send selected findings to an agent without losing the review.
- Preview and publish interactive HTML replies from every harness. Visuals appear inline, follow the app theme, expand for closer inspection, and support source viewing and HTML export. Published local images remain available after their source files are removed.
- Clean up old thread worktrees with an inspection and recovery path. Active work and shared checkouts are protected; automatic cleanup is opt-in and keeps unmerged branches.
- Apply Claude Full access changes by restarting and resuming the native session when idle, or offer Stop and apply now while work is running. Ordinary Enter sends a new message when only a Claude background service remains.
- Group Cursor model choices that differ only by effort, while keeping context-size and other model variants distinct.
- Fix Oh My Pi progress text appearing in the final answer. An explicit recovery command can repair an existing affected answer when its original native history matches exactly.

## 0.6.3

<!-- kybern-release-title: Agents that delegate and talk to each other -->
<!-- kybern-release-summary: Any chat can hand work to agents on other harnesses, in the same branch or their own worktree, and chats can message each other. -->

- Let any chat delegate work to other agents, on any installed harness and model. Children work in the same checkout and branch by default, or in their own worktree started from your uncommitted changes. Their results come back together in one message, and Stop or archive takes the children with it.
- See every agent a chat started in the Agents tab: delegated agents, each harness's own subagents and older helper threads, with status, branch or shared checkout, files touched, conflicts and results. Several agents started in one turn fold into one card.
- Let chats message each other. A question gets an answer back automatically, a message can reach a running chat right away where the harness allows it, and a message to a chat with broader permissions waits for you to deliver or dismiss it. Mention a chat with @ and its agent knows it can write to it.
- Agents in a shared checkout record the files they edit and are warned when they edit files another agent owns. Agents in their own worktree commit on their own branch, and worktrees are cleaned up once their work is merged.
- Set how many agents one chat can run at once and how deep delegation goes in Settings → Agent providers → Delegation.
- A turn cut off by a Kybern restart now ends as interrupted instead of failed, and messages queued behind it still go out.
- Open each harness's own subagents as read-only child threads, with a live status bar, grouped launch rows and sidebar nesting.
- Go back and forward between views with the title-bar arrows, ⌘[ and ⌘], or mouse buttons. The plain `d` theme shortcut is gone; use ⌘K → Toggle theme.
- Select several tasks to change their status or priority, delete them, or send them to agents in one go. Each task page has a Send to agent field.
- Notes and tasks mentioned in messages render as chips with their live titles, and every agent now learns how to use Kybern's tools (Settings → Threads → Tell agents about Kybern).
- The `kybern` command now ships with the app. Add it to your PATH from Settings → About, and set up Cursor from Settings without the terminal.
- Fix Codex showing as Not installed when it's installed through nvm and the app starts before your shell is ready.

## 0.6.2

<!-- kybern-release-title: Agents can use your notes and tasks -->
<!-- kybern-release-summary: Agents can read your notes and tasks, file follow-up tasks and take a task on, and you can start a task's run from the real composer. -->

- Let agents search and read your notes and tasks, write notes, file tasks and claim a task they're working on. They only fully edit what an agent created, never close a task, and ask first unless the chat has Full access or Auto. Each write shows a card with Open and Undo.
- Start a task's run from the real composer on the task page, with every agent, model, effort and permission choice, skills, mentions and attachments. Follow-ups to a running task can carry images and files too.
- Mention notes and tasks in any chat. The @ menu now has All, Threads, Notes, Tasks, Files and Plugins tabs, and @ works without a project.
- Add Notes and Tasks panels to the right dock, and drop the empty dock from the Notes and Tasks pages.
- Quick-added tasks save when you click away. In the Tasks sidebar, Projects can collapse while pinned projects stay visible.
- Paste or drop images into task descriptions. Images in pasted content are uploaded instead of stored inline, and task descriptions can be up to 512 KB.
- Projects added from the CLI, mobile or another window now appear right away, and the plan usage rings in the rail have more room.

## 0.6.1

<!-- kybern-release-title: Projects in Notes and Tasks, images in notes -->
<!-- kybern-release-summary: Pick a project before you write a note or task, paste images into notes, and keep Claude plan usage current. -->

- Choose a project in Tasks and Notes. Every project appears in the Tasks sidebar, and a task's project dot on a list row or board card opens the project picker. New note can start a note in any project. A "+" in both places adds a project without leaving the page.
- Paste, drop or insert images into notes. They're stored on the machine that keeps the note.
- Fix Claude plan usage staying stale on Macs that still have an old Claude credentials file. When usage can't be read, the usage card now says why and what brings it back. A limit that reset since its last reading no longer shows as 100% left.
- Notes use the whole window, without the chat sidebar, and the note header has more room.
- Fix a scrollbar flashing while moving between plan usage rings.

## 0.6.0

<!-- kybern-release-title: Notes, Tasks and live plan usage -->
<!-- kybern-release-summary: Write notes, turn them into tasks an agent can pick up, and see how much of your Claude, Codex and Cursor plans is left, right in the app rail. -->

- Add Notes: global, project and thread notes, with a gallery and a focused writing page. Mention a note to give an agent its contents. Existing thread notes move over automatically, and deleted notes stay in Recently deleted for 30 days.
- Add Tasks: a list and board with Linear-style statuses and drag and drop. Send to agent starts a conversation from a task with your notes as context, and the task moves to Running and then Needs review on its own. Checklist lines in a note can become tasks.
- See how much of your Claude Code, Codex and Cursor plans is left in the app rail. Hover a ring for each limit, when it resets, and whether you're on pace to run out before then. Limits now refresh within a minute and after every turn instead of going stale, and Cursor's plan usage appears for the first time.
- Run new Cursor conversations on Cursor's official SDK, with streaming, sub-agents, model variants and resume. New chats offer Auto-review or Full access. Set it up with `kybern cursor install` and `kybern cursor login`; it needs Node.js 22.13 or later. Existing Cursor chats keep working as before.
- Find models faster in large catalogs: one searchable picker with recent and starred models, sections by backend, and an effort slider. The composer names the backend when two models share a name.
- Redesign the window: Home, Notes, Tasks, Pull requests and Usage sit in an app rail beside one rounded workspace.
- Fix Oh My Pi background commands staying "running" after they finished, and report timeouts and failed exits as failed.
- Fix conversation titles and commit messages silently using Codex when Claude Code was selected.

## 0.5.9

<!-- kybern-release-title: Stay signed in to Claude and Codex -->
<!-- kybern-release-summary: Kybern no longer cuts off Claude Code or Codex while they save a refreshed login, which signed you out about once a day. -->

- Fix having to sign in to Claude Code again almost every day. Kybern stopped its background Claude processes, which read the model list and usage limits, the moment they answered. Sometimes that was while Claude was still saving the login it had just refreshed, and the login was lost. Kybern now lets them finish and exit on their own.
- Stop agents gracefully on macOS, Linux and Windows, so Codex, which refreshes its ChatGPT login the same way, keeps its sign-in too.
- Leave the daily login refresh to your conversations. While the login is about to expire, the model list and the Usage page use their saved values instead of starting Claude in the background.

## 0.5.8

<!-- kybern-release-title: Claude can publish artifacts -->
<!-- kybern-release-summary: Claude agents in Kybern can create and update claude.ai artifacts, and finished reasoning stops showing as still thinking. -->

- Let Claude agents create and update claude.ai artifacts and read their comments. Claude Code keeps these tools off when an app runs it the way Kybern does, so Kybern now turns them on. They need a claude.ai sign-in and are still subject to your organization's policy.
- Stop showing reasoning as still thinking once the agent moves on to its answer or a tool call, on desktop and mobile.

## 0.5.7

<!-- kybern-release-title: Agents remember how to use your apps -->
<!-- kybern-release-summary: When an app needs a trick, agents save a short note, and the next conversation starts from it. See and edit the notes in Settings → Computer use. -->

- Let agents keep notes on how to use each app. When an app needs a non-obvious approach, like WhatsApp's message box ignoring background typing, the agent saves a short note, and later conversations see it the first time they use that app. Review, edit or delete notes in Settings → Computer use → App notes, or with `kybern computer notes`.
- Get WhatsApp messages and mentions right the first time with a built-in note on how its message box works.
- Fix apps opened moments earlier being treated as unknown during computer use.

## 0.5.6

<!-- kybern-release-title: Computer use is about four times faster -->
<!-- kybern-release-summary: Agents click and type in your apps about four times faster, and waste fewer steps in browsers and after screenshots. Update CuaDriver in Settings → Computer use to get the speedup. -->

- Make computer use about four times faster. A click now takes about a quarter of a second instead of over one, because Kybern shortens CuaDriver's one-second wait after every action. Kybern now installs CuaDriver 0.30.1; Settings → Computer use offers the update when you have an older one.
- Start computer use sooner: mentioning @Computer gets CuaDriver ready while the agent reads your request.
- Help agents finish browser tasks: they now open pages by URL instead of clicking page content, which often ignores background clicks.
- Fix screenshots missing from `act` results when the agent skipped the window report, and element references failing after a screenshot.
- Let agents open apps inside other apps, such as DeviceHub inside Xcode, and explain when a window is on another Space.
- Let @Computer work in a chat that started before computer use was turned on. If computer use is off, the agent says so instead of trying shell commands.

## 0.5.5

<!-- kybern-release-title: OMP works again -->
<!-- kybern-release-summary: OMP threads send normally again with OMP 18.3, instead of stopping with an error about collaboration tools. -->

- Fix OMP threads failing with "OMP did not load Kybern's configured collaboration tools" after updating to OMP 18.3. OMP now hides tools from extensions behind on-demand lookups by default; Kybern's tools stay in its normal tool list.

## 0.5.4

<!-- kybern-release-title: Computer use stays light on memory -->
<!-- kybern-release-summary: CuaDriver now uses about 25 MB instead of hundreds of megabytes or more, and stops on its own when agents are done with it. -->

- Keep CuaDriver's memory use to about 25 MB during computer use. Its on-screen agent cursor could hold over a gigabyte of screen images, so it is now off by default; turn on Show the agent’s cursor in Settings → Computer use to bring it back.
- Stop CuaDriver 10 minutes after agents last use it, and when Kybern quits, instead of leaving it running in the background. A CuaDriver another app started is left alone.

## 0.5.3

<!-- kybern-release-title: Computer use is twice as fast -->
<!-- kybern-release-summary: Agents click through apps on your Mac about twice as fast, the live view costs less while it watches, and quitting an app no longer reports an error. -->

- Make each computer-use click about twice as fast. The agent's cursor still shows where it acts, but no longer waits out a long glide before every click.
- Take the live view's pictures between steps without re-reading the app's controls, so watching an agent work adds less time to each step.
- Report a window as closed when the agent quits its app, instead of an error about a window that could not be read.

## 0.5.2

<!-- kybern-release-title: Computer use stays connected -->
<!-- kybern-release-summary: Computer use keeps working after a quiet stretch, steps that visibly worked are reported as working, and the live view shows each step as a clear caption. -->

- Keep computer use working after it has been idle for a while. Agents were refused with "session has ended" until Kybern restarted.
- Report a step as done when the app visibly changed, instead of marking every step unconfirmed and suggesting a foreground retry that was not needed.
- Show the current step in the live view as a caption on the picture, with the target in bold, shortcuts as keys such as ⌘S, and a check when the agent finishes.

## 0.5.1

<!-- kybern-release-title: Let agents use apps on your Mac -->
<!-- kybern-release-summary: Type @Computer and Claude, OpenCode, Cursor, or Pi can read and use the apps on your Mac, with your approval and a live view of each step. Claude model names load reliably on slow machines, and the sidebar can reorder projects and filter threads. -->

- Let Claude, OpenCode, Cursor, and Pi agents use apps on your Mac. Turn it on in Settings → Computer use, which installs CuaDriver and walks you through granting access, then type @Computer in a chat. You approve each app the first time, a floating live view shows what the agent sees, and password managers, Keychain, and System Settings are always off limits. Codex keeps its own computer-use plugin.
- Show @ and $ mentions in the composer as icons and labels, the same as in sent messages, with undo, redo, and plain-text copy and paste.
- Read Claude models from Claude Code's own model list and keep it on disk, so the picker shows full names like Claude Opus 5.5 even on slow or busy machines, and running threads keep the friendly name. Model descriptions now appear under each name on desktop and mobile.
- Reorder projects by dragging their headers, or with Move up and Move down in the project menu. The order is saved per environment.
- Filter sidebar threads to pinned, working, or a single agent from the button next to Add project.
- Open commands, About, Reload agents, and agent settings from a new help menu in the sidebar footer.

## 0.5.0

<!-- kybern-release-title: Kybern uses far less memory -->
<!-- kybern-release-summary: The desktop app holds much less RAM: hidden windows release their transcripts, long tool results and attachment thumbnails stay small, and idle screens and startup no longer keep extra graphics layers. -->

- Release a window's transcript, highlighting and Markdown caches when the window is minimized, fully covered, or hidden, and restore reading position, drafts, attachments, queued prompts, approvals, and terminals when it comes back.
- Keep open tool results light: very long outputs mount only the lines on screen, and copying the whole result still copies all of it exactly.
- Keep only the 16 most recent per-turn change summaries loaded in an open thread; older turns reload theirs when you scroll back to them.
- Decode attachment thumbnails at thumbnail size instead of full resolution. Opening an attachment still shows the original image.
- Stop idle screens from holding extra graphics memory: the split-pane drop preview now appears only while you drag a thread, and sidebar titles and the project list no longer keep their own layers.
- Show the sidebar and home screen already in place when the app launches, and show connection spinners only when connecting takes a moment, which lowers the memory spike at startup. Switching projects keeps its motion.

## 0.4.17

<!-- kybern-release-title: Point to attachments right in your prompt -->
<!-- kybern-release-summary: Mention a pasted image as @image1 to place it exactly where your prompt refers to it, model names stay readable during a session, and mid-turn messages get proper spacing. -->

- Mention pasted or attached files inline as @image1 or @file1. Each attachment shows its label, the @ menu lists attachments first, and the agent receives each mentioned file right where the prompt refers to it.
- Keep the friendly model name, like Claude Opus 5.5, after a Claude session starts instead of switching to the raw model id, and stop adding that id to the picker as a custom model.
- Give messages sent while the agent is working the same spacing as other messages, so they no longer sit flush against the agent's reply.

## 0.4.16

<!-- kybern-release-title: Claude models show their version -->
<!-- kybern-release-summary: The model picker shows the concrete Claude model an alias resolves to, like Claude Opus 5, read from the agent itself. -->

- Show the concrete Claude model behind each alias in the picker, so Opus reads as Claude Opus 5 and Fable as Claude Fable 5.1. The version is read from Claude Code at no cost and cached per version, and stays accurate as new models ship.

## 0.4.15

<!-- kybern-release-title: New models show up without a restart -->
<!-- kybern-release-summary: The model picker refreshes when you open it and gains a reload control, and Claude model names stay accurate as new versions ship. -->

- Refresh the agent model catalog when the model picker opens, and add a Reload models action, so newly released models appear without relaunching the app.
- Add a Reload agents control to the sidebar footer to re-probe installed agents and their models on demand.
- Name Claude models mechanically from the agent instead of a fixed table, so an alias like Opus stays version-accurate as new models ship.

## 0.4.14

<!-- kybern-release-title: Project switching from free chats -->
<!-- kybern-release-summary: Move a new free-chat draft into an existing or newly added project directly from the composer. -->

- Turn the Free chat composer chip into an anchored project picker with clear selection, matching row geometry, and an Add project action.

## 0.4.13

<!-- kybern-release-title: Free chats and clearer conversation context -->
<!-- kybern-release-summary: Start chats without a project, keep drafts visible, see message timing, and steer agents while background work continues. -->

- Start project-free chats from New chat and find them in a collapsible Recents section beneath Projects, with an isolated neutral workspace instead of repository controls.
- Keep unsent work visible with pencil indicators for new-chat and thread drafts, and show the remaining provider prompt-cache window in the composer.
- Group conversations by date and show message timestamps so earlier prompts and responses are easier to place in time.
- Send new instructions while supported harnesses continue background tasks, including Claude Code continuation support and parity checks for other providers.

## 0.4.11

<!-- kybern-release-title: Clearer chat controls -->
<!-- kybern-release-summary: Clear stale notifications and see terminal activity, helper harnesses, and submitted answers more clearly. -->

- Add Dismiss all to clear stale notifications, including errors and pending requests, while allowing new attention events to appear.
- Clarify submitted answers, terminal commands, and background activity with dedicated icons, and show overlapping harness logos for helper threads.
- Refine thread menu spacing and composer input sizing, and remove the overlapping fades when opening Settings.

## 0.4.10

<!-- kybern-release-title: Sidebar blur restored -->
<!-- kybern-release-summary: Restore the frosted macOS sidebar when full translucency is turned off. -->

- Restore native sidebar blur in normal appearance mode so windows behind Kybern no longer show through sharply. Full-content translucency remains optional.
- Correct the regression-test fixture that blocked the unpublished 0.4.9 release. Theme startup and translucency toggles remain covered by release checks.

## 0.4.9

<!-- kybern-release-title: Sidebar blur restored -->
<!-- kybern-release-summary: Restore the frosted macOS sidebar when full translucency is turned off. -->

- Restore native sidebar blur in normal appearance mode so windows behind Kybern no longer show through sharply. Full-content translucency remains optional.
- Add a release regression check covering theme startup and translucency toggles.

## 0.4.8

<!-- kybern-release-title: Quieter helpers, reliable follow-ups -->
<!-- kybern-release-summary: Helper threads stay out of notifications, and follow-up assignments wait until the helper is ready. -->

- Keep helper completions, failures, approvals, and questions out of the notification bell, unread dots, toasts, and system alerts. Details and approval controls remain available inside the helper thread and Work panel.
- Queue follow-up assignments while a helper is busy, and separate queued, working, and attention counts in the Work panel.
- Restore macOS release packaging when optional Apple certificate settings are empty. This release includes the fixes from the unpublished 0.4.7 build.

## 0.4.7

<!-- kybern-release-title: Quieter helpers, reliable follow-ups -->
<!-- kybern-release-summary: Helper threads stay out of notifications, and follow-up assignments wait until the helper is ready. -->

- Keep helper completions, failures, approvals, and questions out of the notification bell, unread dots, toasts, and system alerts. Details and approval controls remain available inside the helper thread and Work panel.
- Queue follow-up assignments while a helper is busy instead of incorrectly marking them as needing attention, then dispatch once the helper is available.
- Separate queued, working, and attention counts in the Work panel so stalled tasks no longer inflate the active count.

## 0.4.6

<!-- kybern-release-title: Lighter chats, clearer controls -->
<!-- kybern-release-summary: Long chats and tool-heavy turns use less peak memory, with clearer notifications, reviewed answers, and steadier agent updates. -->

- Reduce memory spikes in long chats and tool-heavy turns while preserving exact saved results, formatting, and useful motion. Large completed results load on demand, and unnecessary graphics layers and historical-result reads are avoided.
- Answer multiple agent questions one step at a time, move backward to edit, and review all answers before submitting.
- Refine the environment menu, add icon-only copy and download actions to image previews, and preserve pasted-image thumbnails when switching threads.
- Keep narrow composers contained and split chats readable, limit the message navigation rail to user prompts, and make translucent command, file, and skill pickers easier to read.
- Use smaller notification dots: blue for completed, yellow for pending or blocked, and red for errors. Right-click the bell to dismiss completed notices; successful helper completions no longer duplicate notifications.
- Add a new-thread control when the sidebar is collapsed, align active sidebar shapes with hover states, and improve unread completion indicators.
- Deliver collaboration updates without stale duplicate wakeups, and keep completed or reused helper agents' activity accurate across harnesses. Fixes #34 and #35.

## 0.4.5

<!-- kybern-release-title: Steady window controls -->
<!-- kybern-release-summary: The macOS traffic lights settle centered on the toolbar as the window opens, without needing a resize. -->

- The macOS traffic lights settle centered on the toolbar as the window opens, instead of drifting up after the first paint and needing a window resize to correct.

## 0.4.4

<!-- kybern-release-title: Unified settings chrome, steady window controls -->
<!-- kybern-release-summary: Settings share the thread sidebar's chrome and the macOS window controls stay aligned with the toolbar. -->

- Settings share the thread's chrome: the same sidebar width and drag handle, row density, icon set, and a flush content surface instead of an inset card.
- The macOS traffic lights stay centered on the toolbar instead of drifting upward after the window finishes opening.
- The sidebar gains a notification center; the bell reflects live status and filters the sidebar instead of opening a popover.
- Composer picker rows are single-line, and the send button, edit glyph, and top chrome use refreshed Hugeicons.

## 0.4.3

<!-- kybern-release-title: Less retained work, steadier history -->
<!-- kybern-release-summary: Large saved results load when opened, long chats retain less daemon memory, and refreshed icons and usage views keep the workspace clear. -->

- Saved tool results load when opened. Results shared across panes stay available while visible, and closing details releases their mounted content without losing exact output or reconnect recovery.
- The daemon avoids unnecessary transcript and notification copies, omits irrelevant history events from transcript reconstruction, and returns unused allocator pages sooner on supported platforms.
- Long histories start with a correctly sized viewport, avoiding an initial full-history mount and preserving the live edge while older content is released.
- Refreshed Hugeicons, integration controls, and usage details improve workspace consistency. Account limits stay with their environment when switching connections.
- Release publication now requires successful CI for the exact main-branch release commit and successful desktop bundles for every supported platform.

## 0.4.2

<!-- kybern-release-title: A clearer place for your preferences -->
<!-- kybern-release-summary: Explore dedicated settings, clearer usage insights, and a sidebar that keeps helper chats connected to their parent. -->

- Settings opens as a dedicated screen with search and grouped navigation. Notifications and background activity have their own pages, and returning keeps your workspace and focus.
- Preview light, dark, and system themes with a simple selection outline. Screen transitions respect keyboard navigation and reduced motion.
- Explore usage by date, agent, model, or day, with token and reported-cost summaries. Loading, empty results, and failures have clear recovery actions.
- Follow helper chats with indentation and connecting guides beneath their parent in the desktop sidebar.
- Command, file, and skill suggestions now match the composer width, and settings icons align with their labels.
- Cursor can discover the repository's project Agent Skills.

## 0.4.1

<!-- kybern-release-title: Lighter, steadier conversations -->
<!-- kybern-release-summary: Coordinators research before they act and can be deleted, helper results arrive once, and long chats use far less memory. -->

- Project coordinators research the project before implementing. The first send keeps your brief, delegates research, and asks for a reviewed overview before accepting edit or integration assignments; setup progress and your corrections survive restarts.
- Delete a coordinator once its work is inactive. Deletion archives it, keeps worker history, files, and knowledge, and frees the project to start a fresh coordinator.
- Helper results are delivered once. Reading a collaboration message now acknowledges it, so an agent no longer receives the same result again as a queued follow-up. This applies to Codex, Claude Code, OpenCode, Pi, OMP, Cursor, and coordinators.
- Spawned conversations collapse under their parent on desktop, phone, and iPad. Queued updates and delivered results show the sender and formatted content on demand, keeping routing details out of the reading flow.
- Long conversations, dense tool activity, and large code blocks use far less memory while scrolling. The desktop stress workload's peak dropped from about 875 MiB to about 390 MiB, streaming allocates less per token, and an idle conversation settles near 130 MiB.
- The transcript's bottom fade no longer masks the whole scroller on opaque windows, and icons only promote while they animate.

## 0.4.0

<!-- kybern-release-title: Bring your agents together -->
<!-- kybern-release-summary: Delegate across harnesses, keep project knowledge with a coordinator, and follow the work from your chats. -->

- Ask agents to read earlier conversations, contact other threads, and delegate work across installed harnesses. Follow their child chats and results from the conversation.
- Create a project coordinator from the familiar chat composer. It plans work, manages workers, and maintains shared project knowledge; switch its harness when it is idle.
- Choose the tools you want in the right sidebar with **+**. New workspaces start with the panel empty and remember your choices.
- See what changed when a desktop update arrives, with a dismissible release card and full release details. Install from **Update and restart** at the bottom of the sidebar, with download progress and retry after a failed installation.
- Preview Mermaid diagrams in conversations. Switch between preview and source, expand a diagram, or copy its definition; incomplete and invalid diagrams keep a readable source fallback.
- Choose a default OMP profile or override it per project in **Settings → Agents**. Worktrees inherit the project profile, while existing chats keep the profile they started with.
- Browse large conversation histories with lower memory use, while preserving selection, focus, row controls, and deliberate loading of earlier messages.
- Keep the composer and stacked panels readable when translucency or accessibility settings disable blur.

## 0.3.6

- Recover stuck agent turns when an interrupt is acknowledged without a final result or the provider stops responding. After a five-second cancellation deadline, close the stuck session and allow the conversation to resume.
- Settle outstanding tasks and approvals during forced stops, preserve recorded usage, and prevent late events or stale stop requests from affecting newer responses.

## 0.2.5

- Keep Claude background agents and processes in the same running turn across follow-up work, and prevent premature or duplicate completion notifications.
- Keep agent images in chronological work order until the turn completes. Show generated images with the final response and inspection screenshots inside their tool results.
- Open image previews from composer attachments and sent messages, with focus restored after closing.
- Preserve Shift+Enter newlines in sent messages.
- Refine the environment picker with aligned rows, clearer status, and a new-window action beside each environment that leaves the current window unchanged.
- Reuse release build caches from main, cross-compile Intel Mac builds on faster ARM runners, and avoid duplicate artifact uploads.

## 0.2.4

- Resume conversations started in Claude Code, Codex, OpenCode, pi, OMP, or Cursor CLI. Open **Resume session** beside **New thread**, from a project's menu, or with `/resume` and `/sessions`.
- Find saved conversations by title, project, folder, or session ID with an **All agents** filter. Import available message and tool history, preserve the native session, and reopen existing Kybern threads without duplicates.
- Keep Claude background completions and follow-up tools in their original turn. Automatically continue when native background work finishes and replace provisional waiting messages with the final answer.
- Preserve continuation state, usage, and history across reloads. Add regression checks for all six session formats, atomic imports, keyboard navigation, and light/dark and narrow native layouts.

## 0.2.3

- Reduce retained conversation memory with bounded inactive caches, compact background updates, and cache release when switching environments. Preserve drafts, pending controls, split panes, and live updates during history reloads.
- Bound event, terminal, and WebSocket buffers by bytes, with durable event replay and terminal scrollback recovery for slow clients.
- Release idle Markdown and highlighting workers and cap provider discovery cache entries.
- Show compact, deferred image thumbnails and load full-resolution originals only when opened.
- Fix table wrapping and horizontal overflow in narrow conversations.
- Add Open in new window to environment menus with independent environment selection per window.
- Add native memory comparisons and regression coverage for rendering, image previews, cache eviction, and recovery.

## 0.2.2

- Count time asleep toward idle agent expiry, so overdue processes close on the first cleanup sweep after waking.
- Stop opening threads, reconnecting, and subscribing to events from extending idle agent lifetimes. Conversations still resume on the next message.
- Preserve active work and approval waits, and recheck activity before closing a selected idle process.

## 0.2.1

- Redesign agent question forms with clearer hierarchy, multiline answers, quieter choices, and responsive action layouts.
- Fix context usage warnings turning near-black instead of amber at 80–94% usage.
- Open local image links in an authenticated in-app preview and provide useful recovery guidance for blocked image paths.
- Give agents thread-specific artifact guidance and document preview placement in the repository instructions.
- Preserve the desktop performance findings and visual-quality requirements in AGENTS.md, CLAUDE.md, and the performance guide.
- Add native WebKit regression checks for question forms and artifact previews.

## 0.2.0

- Virtualize long conversation histories, expanded tool groups, and agent activity to keep mounted interface work bounded.
- Move large Markdown parsing off the interface thread and reuse completed blocks as text streams, preserving GFM, links, footnotes, code controls, and exact final output.
- Navigate every message through a virtualized rail with keyboard support and bounded geometry reads.
- Preserve reading position, following, selections, focus, wrapping, and expansion state while virtual rows mount and unmount.
- Fix sidebar context menus and submenus appearing transparent without blur in Translucent app mode.
- Add M1 native WebKit measurements and regression checks for large histories, growing Markdown, navigation, tool expansion, and menu materials.

## 0.1.9

- Make cards, controls, message bubbles, menus, and dialogs consistently translucent in Translucent app mode.
- Improve long-thread scrolling by preserving settled turn identities and removing collapsed work details from the rendered page.
- Move syntax highlighting off the interface thread, bound queued work and cached results, and pace highlighting while code streams.
- Preserve code-block wrapping and highlighted content while surrounding Markdown updates.
- Reduce streaming Markdown updates and cache message-navigation previews to avoid repeatedly reading historical messages.
- Add native WebKit rendering regression coverage using the production content security policy.

## 0.1.8

- Fix Translucent app mode remaining opaque outside the sidebar on macOS.
- Add native WebKit regression coverage for window materials, settings, floating surfaces, and accessibility fallbacks.

## 0.1.7

- Reduce running-indicator repaint work and pause looping indicators when they are hidden or offscreen.
- Fix full-app translucency being hidden by an opaque content wrapper, and avoid stacking an extra tint in split panes.
- Redesign the context-usage popover with clearer token counts, usage meters, separate account limits, and keyboard access.
- Keep native ResizeObserver layout diagnostics out of fatal error banners and defer resize work to the next frame.
- Replace raw interface-error banners with a compact notice with expandable technical details, copy, and dismiss actions.
- Rebuild the mobile client around native tabs and Liquid Glass surfaces, with updated connection, thread, approval, and settings screens.

## 0.1.6

- Start drafting immediately while harness discovery refreshes, with cached harness choices on subsequent launches.
- Show context usage in the composer, with token details, supported account usage windows, and reset times on hover or focus.
- Add native manual compaction and discovered slash commands where supported by each harness.
- Add full-app translucency in Appearance, including floating surfaces and the terminal, with accessibility fallbacks.
- Fix composer wrapping, caret scrolling, and spacing alignment.
- Close owned harness processes reliably during session release and failed startup; preserve conversation history and provide safe reconnect guidance for Codex writer conflicts.
- Prevent Codex from appearing as its own subagent after resume, and exclude old false entries from activity views.
- Render Codex asynchronous questions as answerable forms. Keep unanswered forms across reloads and deliver submitted answers while the agent works.

Account limits and commands depend on the installed harness protocol. Kybern does not infer missing quotas or expose unsupported terminal-only commands.
