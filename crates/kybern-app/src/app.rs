//! The workspace: one view that owns the model, the daemon bridge, and the
//! three panes. Child state that needs its own entity (editors, scrollers,
//! resizable groups) lives here too.

use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use gpui::*;
use gpui::prelude::FluentBuilder as _;
use gpui_component::input::{EditorState, InputEvent, InputState, TextareaState};
use gpui_component::message_scroller::MessageScrollerState;
use gpui_component::notification::Notification;
use gpui_component::resizable::ResizableState;
use gpui_component::{ActiveTheme as _, Root, Theme, WindowExt as _, h_resizable, resizable_panel, v_flex};
use kybern_protocol::methods::{Empty as NoParams, *};
use kybern_protocol::*;

use crate::daemon::{Daemon, as_thread_event};
use crate::state::{Connection, Model};
use crate::views;

actions!(
    kybern,
    [
        NewThread,
        SendMessage,
        Interrupt,
        ToggleRightPanel,
        ToggleSidebar,
        FocusComposer,
        OpenPalette,
        OpenTerminal,
        OpenChanges,
        OpenSettings,
        OpenUsage,
        ArchiveThread,
        SelectPreviousThread,
        SelectNextThread,
        AddProject,
        CreatePullRequest,
        Quit
    ]
);

pub fn init_actions(cx: &mut App) {
    cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
}

/// Commands shown in the palette. Order is display order.
pub const COMMANDS: &[(&str, &str, fn() -> Box<dyn Action>)] = &[
    ("New thread", "Start a thread in the selected project", || Box::new(NewThread)),
    ("Add project", "Choose a folder to work in", || Box::new(AddProject)),
    ("Stop the current turn", "Interrupt the agent", || Box::new(Interrupt)),
    ("Archive thread", "Hide the selected thread", || Box::new(ArchiveThread)),
    ("Create pull request", "Commit, push and open a PR with gh", || Box::new(CreatePullRequest)),
    ("Show changes", "Open the Changes tab", || Box::new(OpenChanges)),
    ("Show terminal", "Open the Terminal tab", || Box::new(OpenTerminal)),
    ("Toggle sidebar", "", || Box::new(ToggleSidebar)),
    ("Toggle right panel", "", || Box::new(ToggleRightPanel)),
    ("Usage", "Tokens and cost by provider", || Box::new(OpenUsage)),
    ("Settings", "Open settings.json and keybindings.json", || Box::new(OpenSettings)),
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RightTab {
    Changes,
    Terminal,
}

pub struct ComposerSettings {
    pub provider: ProviderKind,
    pub mode: PermissionMode,
    pub worktree: bool,
}

pub struct Workspace {
    pub daemon: Arc<Daemon>,
    pub model: Model,
    pub focus: FocusHandle,
    pub composer: Entity<TextareaState>,
    pub composer_settings: ComposerSettings,
    pub scroller: Entity<MessageScrollerState>,
    pub split: Entity<ResizableState>,
    pub right_split: Entity<ResizableState>,
    pub diff_editor: Entity<EditorState>,
    pub diff: Option<Diff>,
    pub diff_loading: bool,
    pub right_tab: RightTab,
    pub show_right: bool,
    pub show_sidebar: bool,
    pub terminals: HashMap<ThreadId, views::terminal::TerminalView>,
    pub terminal_input: Entity<InputState>,
    /// Tool blocks the user expanded.
    pub expanded_tools: std::collections::HashSet<String>,
    pub sending: bool,
    pub palette: Entity<gpui_component::command::CommandState>,
    pub usage: Option<UsageSummaryResult>,
    pub pending_toast: Option<String>,
    pub pending_system_notice: Option<(ThreadId, String, String)>,
    pub pending_toast_info: Option<String>,
    pub diff_dirty: bool,
    _subscriptions: Vec<Subscription>,
    _pump: Option<Task<()>>,
}

impl Workspace {
    pub fn new(daemon: Arc<Daemon>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Theme::sync_system_appearance(Some(window), cx);
        Theme::global_mut(cx).font_size = px(13.);
        Theme::global_mut(cx).radius = px(6.);
        Theme::sync_base(cx);

        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 8)
                .submit_on_enter(true)
                .placeholder("Message the agent")
                .soft_wrap(true)
        });
        let terminal_input = cx.new(|cx| InputState::new(window, cx).placeholder("Type a command and press Enter"));
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let palette = cx.new(|cx| gpui_component::command::CommandState::new(window, cx));
        let diff_editor = cx.new(|cx| EditorState::new(window, cx).language("diff").line_number(false).soft_wrap(false).folding(false));

        let mut subs = Vec::new();
        subs.push(window.observe_window_appearance(|window, cx| {
            Theme::sync_system_appearance(Some(window), cx);
        }));
        subs.push(cx.subscribe_in(&composer, window, |this: &mut Self, input, event, window, cx| {
            if let InputEvent::PressEnter { shift, .. } = event {
                if !*shift {
                    let text = input.read(cx).value().trim().to_string();
                    if !text.is_empty() {
                        input.update(cx, |s, cx| s.set_value("", window, cx));
                        this.send_text(text, cx);
                    }
                }
            }
        }));
        subs.push(cx.subscribe_in(&terminal_input, window, |this: &mut Self, input, event, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let line = input.read(cx).value().to_string();
                input.update(cx, |s, cx| s.set_value("", window, cx));
                this.terminal_send_line(line, cx);
            }
        }));
        subs.push(cx.observe(&scroller, |_, _, cx| cx.notify()));

        let mut this = Self {
            daemon,
            model: Model::default(),
            focus: cx.focus_handle(),
            composer,
            composer_settings: ComposerSettings { provider: ProviderKind::ClaudeCode, mode: PermissionMode::Supervised, worktree: false },
            scroller,
            split: cx.new(|_| ResizableState::default()),
            right_split: cx.new(|_| ResizableState::default()),
            diff_editor,
            diff: None,
            diff_loading: false,
            right_tab: RightTab::Changes,
            show_right: true,
            show_sidebar: true,
            terminals: HashMap::new(),
            terminal_input,
            expanded_tools: Default::default(),
            sending: false,
            palette,
            usage: None,
            pending_toast: None,
            pending_system_notice: None,
            pending_toast_info: None,
            diff_dirty: false,
            _subscriptions: subs,
            _pump: None,
        };
        this.start(cx);
        this
    }

    // ---- startup and live events ----

    fn start(&mut self, cx: &mut Context<Self>) {
        let rx = self.daemon.take_notifications();
        self._pump = Some(cx.spawn(async move |this, cx| {
            let mut rx = rx;
            while let Some(n) = rx.next().await {
                if this.update(cx, |ws, cx| ws.handle_notification(n, cx)).is_err() {
                    break;
                }
            }
            let _ = this.update(cx, |ws, cx| {
                ws.model.connection = Connection::Lost("The daemon closed the connection.".into());
                cx.notify();
            });
        }));

        self.load_initial(cx);
    }

    /// Fetch daemon state. Retries with backoff until it succeeds, so a slow or
    /// restarting daemon never leaves the window stuck on "Connecting".
    fn load_initial(&mut self, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                let timeout = std::time::Duration::from_secs(8);
                let load = async {
                    let info = d.call::<DaemonInfoMethod>(NoParams {}).await?;
                    let providers = d.call::<ProvidersList>(NoParams {}).await?;
                    let projects = d.call::<ProjectsList>(NoParams {}).await?;
                    let threads = d.call::<ThreadsList>(ThreadsListParams::default()).await?;
                    d.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: None, after_seq: None }).await?;
                    anyhow::Ok((info, providers, projects, threads))
                };
                let timer = cx.background_executor().timer(timeout);
                let load = std::pin::pin!(load);
                let timer = std::pin::pin!(timer);
                let result = futures::future::select(load, timer).await;
                match result {
                    futures::future::Either::Left((Ok((info, p, pr, t)), _)) => {
                        this.update(cx, |ws, cx| {
                            ws.model.info = Some(info);
                            ws.model.providers = p.providers;
                            if !ws.model.providers.iter().any(|x| x.kind == ws.composer_settings.provider && x.available) {
                                if let Some(first) = ws.model.available_providers().first() {
                                    ws.composer_settings.provider = first.kind;
                                }
                            }
                            ws.model.projects = pr.projects.into_iter().map(|p| (p.id, p)).collect();
                            ws.model.threads = t.threads.into_iter().map(|t| (t.id, t)).collect();
                            ws.model.connection = Connection::Connected;
                            if ws.model.selected_project.is_none() {
                                ws.model.selected_project = ws.model.projects.keys().next().copied();
                            }
                            if ws.model.selected_thread.is_none() {
                                if let Some(t) = ws.model.threads.values().max_by_key(|t| t.updated_at).map(|t| t.id) {
                                    ws.select_thread(t, cx);
                                }
                            }
                            cx.notify();
                        })
                        .ok();
                        return;
                    }
                    futures::future::Either::Left((Err(e), _)) => {
                        tracing::warn!(attempt, %e, "initial load failed");
                        if d.is_closed() {
                            this.update(cx, |ws, cx| {
                                ws.model.connection = Connection::Lost(e.to_string());
                                cx.notify();
                            })
                            .ok();
                            return;
                        }
                    }
                    futures::future::Either::Right(_) => {
                        tracing::warn!(attempt, "initial load timed out; retrying");
                    }
                }
                cx.background_executor().timer(std::time::Duration::from_millis(500 * attempt.min(6) as u64)).await;
            }
        })
        .detach();
    }

    fn handle_notification(&mut self, n: RpcNotification, cx: &mut Context<Self>) {
        if let Some(en) = as_thread_event(&n) {
            let thread_id = en.event.thread_id;
            let was_running = self.model.threads.get(&thread_id).map(|t| t.status);
            let is_turn_end = matches!(en.event.payload, EventPayload::TurnCompleted { .. } | EventPayload::TurnFailed { .. });
            let is_approval = matches!(en.event.payload, EventPayload::ApprovalRequested { .. });
            let before = self.model.transcripts.get(&thread_id).map(|t| t.blocks.len()).unwrap_or(0);
            if self.model.apply_event(en.event) {
                if self.model.selected_thread == Some(thread_id) {
                    let after = self.model.transcripts.get(&thread_id).map(|t| t.blocks.len()).unwrap_or(0);
                    self.scroller.update(cx, |s, cx| {
                        if after > before {
                            s.append(after - before, cx);
                        } else if after > 0 {
                            s.remeasure_items(after.saturating_sub(1)..after, cx);
                        }
                    });
                    if is_turn_end {
                        self.load_diff(thread_id, cx);
                    }
                }
                if is_approval || is_turn_end {
                    self.notify_background(thread_id, is_approval, was_running, cx);
                }
                cx.notify();
            }
            return;
        }
        if n.method == TERMINAL_OUTPUT_NOTIFICATION || n.method == TERMINAL_EXITED_NOTIFICATION {
            views::terminal::handle_notification(self, &n, cx);
            return;
        }
        if n.method == "events.lagged" {
            self.resync(cx);
        }
    }

    /// OS notification when a thread needs attention and the window is not active.
    fn notify_background(&mut self, thread_id: ThreadId, is_approval: bool, _was: Option<ThreadStatus>, cx: &mut Context<Self>) {
        let Some(t) = self.model.threads.get(&thread_id) else { return };
        if cx.active_window().is_some() {
            return;
        }
        let title = t.title.clone();
        let body = if is_approval { "Needs your approval" } else { "Finished the turn" };
        self.pending_system_notice = Some((thread_id, title, body.to_string()));
        cx.notify();
    }

    fn resync(&mut self, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        let selected = self.model.selected_thread;
        cx.spawn(async move |this, cx| {
            let threads = d.call::<ThreadsList>(ThreadsListParams::default()).await;
            let _ = d.call::<EventsSubscribe>(EventsSubscribeParams { thread_id: None, after_seq: None }).await;
            this.update(cx, |ws, cx| {
                if let Ok(t) = threads {
                    ws.model.threads = t.threads.into_iter().map(|t| (t.id, t)).collect();
                }
                if let Some(id) = selected {
                    ws.load_thread(id, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---- selection and loading ----

    pub fn select_thread(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.model.selected_thread = Some(id);
        if let Some(t) = self.model.threads.get(&id) {
            self.model.selected_project = Some(t.project_id);
            self.composer_settings.provider = t.provider.kind;
            self.composer_settings.mode = t.permission_mode;
        }
        self.diff = None;
        let count = self.model.transcripts.get(&id).map(|t| t.blocks.len()).unwrap_or(0);
        self.scroller.update(cx, |s, cx| s.reset(count, cx));
        if !self.model.transcripts.get(&id).is_some_and(|t| t.loaded) {
            self.load_thread(id, cx);
        } else {
            self.load_diff(id, cx);
        }
        cx.notify();
    }

    pub fn start_draft(&mut self, project: ProjectId, cx: &mut Context<Self>) {
        self.model.selected_project = Some(project);
        self.model.selected_thread = None;
        self.diff = None;
        self.scroller.update(cx, |s, cx| s.reset(0, cx));
        cx.notify();
    }

    fn load_thread(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let r = d.call::<ThreadsGet>(ThreadsGetParams { thread_id: id }).await;
            let cps = d.call::<ThreadsCheckpoints>(ThreadsCheckpointsParams { thread_id: id }).await;
            this.update(cx, |ws, cx| {
                if let Ok(r) = r {
                    ws.model.load_transcript(r);
                    if let Ok(c) = cps {
                        ws.model.thread_state(id).checkpoints = c.checkpoints;
                    }
                    if ws.model.selected_thread == Some(id) {
                        let count = ws.model.transcripts.get(&id).map(|t| t.blocks.len()).unwrap_or(0);
                        ws.scroller.update(cx, |s, cx| {
                            s.reset(count, cx);
                            s.scroll_to_end(cx);
                        });
                        ws.load_diff(id, cx);
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn load_diff(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(project) = self.model.threads.get(&id).and_then(|t| self.model.projects.get(&t.project_id)) else { return };
        if !project.is_git {
            self.diff = None;
            return;
        }
        self.diff_loading = true;
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let r = d.call::<ThreadsDiff>(ThreadsDiffParams { thread_id: id, turn_id: None }).await;
            this.update(cx, |ws, cx| {
                ws.diff_loading = false;
                if ws.model.selected_thread == Some(id) {
                    ws.diff = r.ok();
                    ws.diff_dirty = true;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---- actions ----

    pub fn send_text(&mut self, text: String, cx: &mut Context<Self>) {
        let message = UserMessage::text(text);
        let d = self.daemon.clone();
        match self.model.selected_thread {
            Some(thread_id) => {
                self.sending = true;
                cx.spawn(async move |this, cx| {
                    let r = d.call::<ThreadsSend>(ThreadsSendParams { thread_id, message }).await;
                    this.update(cx, |ws, cx| {
                        ws.sending = false;
                        if let Err(e) = r {
                            ws.toast_error(format!("Unable to send. {e}"), cx);
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
            None => {
                let Some(project_id) = self.model.selected_project else {
                    self.toast_error("Add a project first.".into(), cx);
                    return;
                };
                let params = ThreadsCreateParams {
                    project_id,
                    provider: ProviderInstance::default_for(self.composer_settings.provider),
                    model: None,
                    permission_mode: Some(self.composer_settings.mode),
                    use_worktree: if self.composer_settings.worktree { Some(true) } else { None },
                    title: None,
                    message: Some(message),
                };
                self.sending = true;
                cx.spawn(async move |this, cx| {
                    let r = d.call::<ThreadsCreate>(params).await;
                    this.update(cx, |ws, cx| {
                        ws.sending = false;
                        match r {
                            Ok(t) => {
                                let id = t.id;
                                ws.model.threads.insert(id, t);
                                ws.select_thread(id, cx);
                            }
                            Err(e) => ws.toast_error(format!("Unable to start the thread. {e}"), cx),
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    pub fn interrupt(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self.model.selected_thread else { return };
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            if let Err(e) = d.call::<ThreadsInterrupt>(ThreadsInterruptParams { thread_id }).await {
                this.update(cx, |ws, cx| ws.toast_error(format!("Unable to stop. {e}"), cx)).ok();
            }
        })
        .detach();
    }

    pub fn respond_approval(&mut self, approval_id: ApprovalId, decision: ApprovalDecision, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            if let Err(e) = d.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id, decision }).await {
                this.update(cx, |ws, cx| ws.toast_error(format!("Unable to answer. {e}"), cx)).ok();
            }
        })
        .detach();
    }

    pub fn set_thread_mode(&mut self, mode: PermissionMode, cx: &mut Context<Self>) {
        self.composer_settings.mode = mode;
        if let Some(thread_id) = self.model.selected_thread {
            let d = self.daemon.clone();
            cx.spawn(async move |this, cx| {
                let r = d.call::<ThreadsUpdate>(ThreadsUpdateParams { thread_id, title: None, pinned: None, permission_mode: Some(mode), model: None }).await;
                if let Err(e) = r {
                    this.update(cx, |ws, cx| ws.toast_error(format!("Mode not changed. {e}"), cx)).ok();
                }
            })
            .detach();
        }
        cx.notify();
    }

    pub fn add_project(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add project".into()) });
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let Some(path) = paths.first() else { return };
            let r = d.call::<ProjectsAdd>(ProjectsAddParams { path: path.to_string_lossy().to_string(), name: None }).await;
            this.update(cx, |ws, cx| match r {
                Ok(p) => {
                    let id = p.id;
                    ws.model.projects.insert(id, p);
                    ws.start_draft(id, cx);
                }
                Err(e) => ws.toast_error(format!("Unable to add the project. {e}"), cx),
            })
            .ok();
        })
        .detach();
    }

    pub fn archive_thread(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let r = d.call::<ThreadsArchive>(ThreadsArchiveParams { thread_id: id }).await;
            this.update(cx, |ws, cx| {
                if r.is_ok() {
                    if let Some(t) = ws.model.threads.get_mut(&id) {
                        t.status = ThreadStatus::Archived;
                    }
                    if ws.model.selected_thread == Some(id) {
                        ws.model.selected_thread = None;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn revert_to(&mut self, thread_id: ThreadId, turn_id: TurnId, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let r = d.call::<ThreadsRevert>(ThreadsRevertParams { thread_id, turn_id }).await;
            this.update(cx, |ws, cx| match r {
                Ok(_) => ws.load_thread(thread_id, cx),
                Err(e) => ws.toast_error(format!("Unable to revert. {e}"), cx),
            })
            .ok();
        })
        .detach();
    }

    pub fn select_relative(&mut self, delta: i32, cx: &mut Context<Self>) {
        let Some(project) = self.model.selected_project else { return };
        let ids: Vec<ThreadId> = self.model.threads_for_project(project).into_iter().map(|t| t.id).collect();
        if ids.is_empty() {
            return;
        }
        let ix = self.model.selected_thread.and_then(|s| ids.iter().position(|i| *i == s)).map(|i| i as i32).unwrap_or(-1);
        let next = (ix + delta).rem_euclid(ids.len() as i32) as usize;
        self.select_thread(ids[next], cx);
    }

    pub fn confirm_archive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.model.selected_thread else { return };
        let title = self.model.threads.get(&id).map(|t| t.title.clone()).unwrap_or_default();
        let view = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            alert
                .title("Archive this thread?")
                .description(format!("“{title}” will be hidden from the sidebar. Its files and history stay on disk."))
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("Archive thread").cancel_text("Cancel").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    view.update(cx, |ws, cx| ws.archive_thread(id, cx));
                    true
                })
                .keyboard(true)
        });
    }

    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let palette = self.palette.clone();
        let view = cx.entity();
        palette.update(cx, |s, cx| s.set_query("", window, cx));
        window.open_dialog(cx, move |dialog, _, _| {
            let palette = palette.clone();
            let view = view.clone();
            dialog.close_button(false).p_0().w(px(560.)).overlay(true).content(move |content, window, cx| {
                let palette2 = palette.clone();
                window.defer(cx, move |window, cx| palette2.read(cx).focus_handle(cx).focus(window, cx));
                let mut cmd = gpui_component::command::Command::new(&palette).placeholder("Type a command").bordered(false).max_h(px(420.));
                for (label, desc, make) in COMMANDS {
                    let _ = desc;
                    cmd = cmd.item(gpui_component::command::CommandItem::new().label(*label).action(make()));
                }
                let view = view.clone();
                content.child(cmd.on_confirm(move |ix, window, cx| {
                    if let Some((_, _, make)) = COMMANDS.get(ix.row) {
                        window.close_dialog(cx);
                        let action = make();
                        let view = view.clone();
                        window.defer(cx, move |window, cx| {
                            view.update(cx, |ws, cx| {
                                ws.focus.focus(window, cx);
                                cx.notify();
                            });
                            window.dispatch_action(action, cx);
                        });
                    }
                }))
            })
        });
    }

    pub fn open_settings(&mut self, cx: &mut Context<Self>) {
        let Some(dir) = kybern_client::Endpoint::data_dir(None) else { return };
        cx.reveal_path(&dir.join("settings.json"));
    }

    pub fn open_usage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let d = self.daemon.clone();
        let view = cx.entity();
        cx.spawn_in(window, async move |this, cx| {
            let r = d.call::<UsageSummary>(UsageSummaryParams { since: None, group_by: UsageGroup::Provider }).await;
            this.update_in(cx, |ws, window, cx| {
                match r {
                    Ok(u) => {
                        ws.usage = Some(u);
                        views::usage::open(ws, view.clone(), window, cx);
                    }
                    Err(e) => ws.toast_error(format!("Unable to load usage. {e}"), cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn create_pull_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self.model.selected_thread else { return };
        let d = self.daemon.clone();
        let view = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let d = d.clone();
            let view = view.clone();
            alert
                .title("Create a pull request?")
                .description("Uncommitted changes are committed with a generated message, the branch is pushed, and a pull request opens with a generated title and description.")
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("Create pull request").cancel_text("Cancel").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    let d = d.clone();
                    let view = view.clone();
                    cx.spawn(async move |cx| {
                        let r = d.call::<PrCreate>(PrCreateParams { thread_id, title: None, body: None, base: None, draft: false, commit_first: true }).await;
                        let _ = view.update(cx, |ws, cx| {
                            match r {
                                Ok(pr) => {
                                    ws.pending_toast_info = Some(format!("Opened #{}: {}", pr.number, pr.title));
                                    cx.open_url(&pr.url);
                                }
                                Err(e) => ws.toast_error(format!("Unable to create the pull request. {e}"), cx),
                            }
                            cx.notify();
                        });
                    })
                    .detach();
                    true
                })
        });
    }

    pub fn toast_error(&mut self, text: String, cx: &mut Context<Self>) {
        self.pending_toast = Some(text);
        cx.notify();
    }

    pub fn terminal_send_line(&mut self, line: String, cx: &mut Context<Self>) {
        views::terminal::send_line(self, line, cx);
    }

    pub fn selected_thread(&self) -> Option<&Thread> {
        self.model.selected_thread.and_then(|id| self.model.threads.get(&id))
    }

    pub fn is_running(&self) -> bool {
        self.selected_thread().is_some_and(|t| matches!(t.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval))
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(text) = self.pending_toast.take() {
            window.push_notification(Notification::error(text).autohide(true), cx);
        }
        if let Some(text) = self.pending_toast_info.take() {
            window.push_notification(Notification::success(text).autohide(true), cx);
        }
        if let Some((thread_id, title, body)) = self.pending_system_notice.take() {
            let view = cx.entity();
            window.push_notification(
                Notification::info(body).title(title).in_app_and_system().on_click(move |_, _, cx| {
                    view.update(cx, |ws, cx| ws.select_thread(thread_id, cx));
                }),
                cx,
            );
        }
        if self.diff_dirty {
            self.diff_dirty = false;
            let text = self.diff.as_ref().map(|d| d.patch.clone()).unwrap_or_default();
            self.diff_editor.update(cx, |s, cx| s.set_value(text, window, cx));
        }

        let sheet_layer = Root::render_sheet_layer(window, cx);
        let dialog_layer = Root::render_dialog_layer(window, cx);
        let notification_layer = Root::render_notification_layer(window, cx);

        let sidebar = views::sidebar::render(self, window, cx);
        let thread = views::transcript::render_pane(self, window, cx);
        let right = views::changes::render_right_panel(self, window, cx);
        let title_bar = views::sidebar::render_title_bar(self, window, cx);
        let (show_sidebar, show_right) = (self.show_sidebar, self.show_right);

        let body = h_resizable("main-split")
            .with_state(&self.split)
            .when(show_sidebar, |g| g.child(resizable_panel().size(px(248.)).size_range(px(200.)..px(380.)).child(sidebar)))
            .child(resizable_panel().child(thread))
            .when(show_right, |g| g.child(resizable_panel().size(px(400.)).size_range(px(300.)..px(720.)).child(right)));

        div()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NewThread, _, cx| {
                if let Some(p) = this.model.selected_project {
                    this.start_draft(p, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &Interrupt, _, cx| this.interrupt(cx)))
            .on_action(cx.listener(|this, _: &ToggleRightPanel, _, cx| {
                this.show_right = !this.show_right;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.show_sidebar = !this.show_sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &FocusComposer, window, cx| {
                this.composer.update(cx, |s, cx| s.focus(window, cx));
            }))
            .on_action(cx.listener(|this, _: &OpenPalette, window, cx| this.open_palette(window, cx)))
            .on_action(cx.listener(|this, _: &OpenTerminal, _, cx| {
                this.show_right = true;
                this.right_tab = RightTab::Terminal;
                views::terminal::ensure_terminal(this, cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenChanges, _, cx| {
                this.show_right = true;
                this.right_tab = RightTab::Changes;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenUsage, window, cx| this.open_usage(window, cx)))
            .on_action(cx.listener(|this, _: &OpenSettings, _, cx| this.open_settings(cx)))
            .on_action(cx.listener(|this, _: &AddProject, _, cx| this.add_project(cx)))
            .on_action(cx.listener(|this, _: &ArchiveThread, window, cx| this.confirm_archive(window, cx)))
            .on_action(cx.listener(|this, _: &CreatePullRequest, window, cx| this.create_pull_request(window, cx)))
            .on_action(cx.listener(|this, _: &SelectPreviousThread, _, cx| this.select_relative(-1, cx)))
            .on_action(cx.listener(|this, _: &SelectNextThread, _, cx| this.select_relative(1, cx)))
            .size_full()
            .relative()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                v_flex()
                    .size_full()
                    .child(title_bar)
                    .child(div().flex_1().min_h_0().overflow_hidden().child(body))
                    .children(sheet_layer)
                    .children(dialog_layer)
                    .children(notification_layer),
            )
    }
}

// Fields added after the struct definition to keep the constructor readable.
impl Workspace {
    pub fn connection_line(&self) -> Option<String> {
        match &self.model.connection {
            Connection::Connected => None,
            Connection::Connecting => Some("Connecting to the daemon".into()),
            Connection::Lost(e) => Some(format!("Disconnected. {e}")),
        }
    }
}
