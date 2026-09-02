//! Terminal tab. The daemon owns the PTY; this view keeps a `kybern_term`
//! VT state per thread, feeds it the bytes that arrive over the socket, and
//! renders it with `TerminalElement`, which sends keystrokes back as bytes
//! and reports the grid size that fits the pane so we can resize the PTY.

use base64::Engine;
use gpui::*;
use gpui::prelude::FluentBuilder as _;
use gpui_component::{ActiveTheme as _, v_flex};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use kybern_term::{Palette, TerminalElement, TerminalState};

use crate::app::Workspace;

/// Size used for the PTY until the pane has been measured.
const INITIAL_COLS: u16 = 100;
const INITIAL_ROWS: u16 = 30;

pub struct TerminalView {
    pub id: Option<TerminalId>,
    pub state: Entity<TerminalState>,
    pub focus: FocusHandle,
    /// Grid size the daemon currently has (or will get on create).
    pub size: (u16, u16),
    pub error: Option<String>,
    pub exited: Option<Option<i32>>,
    pub creating: bool,
}

impl TerminalView {
    fn new(cx: &mut Context<Workspace>) -> Self {
        Self {
            id: None,
            state: cx.new(|_| TerminalState::new(INITIAL_COLS, INITIAL_ROWS)),
            focus: cx.focus_handle(),
            size: (INITIAL_COLS, INITIAL_ROWS),
            error: None,
            exited: None,
            creating: false,
        }
    }
}

pub fn ensure_terminal(ws: &mut Workspace, cx: &mut Context<Workspace>) {
    let Some(thread_id) = ws.model.selected_thread else { return };
    if !ws.terminals.contains_key(&thread_id) {
        let view = TerminalView::new(cx);
        ws.terminals.insert(thread_id, view);
    }
    let entry = ws.terminals.get_mut(&thread_id).expect("inserted above");
    if entry.id.is_some() || entry.creating {
        return;
    }
    entry.creating = true;
    entry.error = None;
    let (cols, rows) = entry.size;
    let d = ws.daemon.clone();
    cx.spawn(async move |this, cx| {
        let r = d.call::<TerminalsCreate>(TerminalsCreateParams { thread_id: Some(thread_id), cwd: None, cols, rows, command: None }).await;
        let id = match &r {
            Ok(info) => Some(info.id),
            Err(_) => None,
        };
        if let Some(id) = id {
            let _ = d.call::<TerminalsSubscribe>(TerminalsSubscribeParams { terminal_id: id, replay: true }).await;
        }
        this.update(cx, |ws, cx| {
            if let Some(t) = ws.terminals.get_mut(&thread_id) {
                t.creating = false;
                match r {
                    Ok(info) => {
                        t.id = Some(info.id);
                        // The pane may have been measured while we were creating.
                        let (cols, rows) = t.state.read(cx).size().into_tuple();
                        if (cols, rows) != t.size {
                            resize(ws, thread_id, cols, rows, cx);
                        }
                    }
                    Err(e) => t.error = Some(format!("Unable to open a terminal. {e}")),
                }
            }
            cx.notify();
        })
        .ok();
    })
    .detach();
}

/// Write raw bytes to the selected thread's PTY.
pub fn send_bytes(ws: &mut Workspace, thread_id: ThreadId, bytes: Vec<u8>, cx: &mut Context<Workspace>) {
    if bytes.is_empty() {
        return;
    }
    let Some(id) = ws.terminals.get(&thread_id).and_then(|t| t.id) else { return };
    let d = ws.daemon.clone();
    cx.spawn(async move |_, _| {
        let _ = d.call::<TerminalsInput>(TerminalsInputParams { terminal_id: id, data: base64::engine::general_purpose::STANDARD.encode(&bytes) }).await;
    })
    .detach();
}

/// Type a line followed by Enter into the selected thread's terminal.
pub fn send_line(ws: &mut Workspace, line: String, cx: &mut Context<Workspace>) {
    let Some(thread_id) = ws.model.selected_thread else { return };
    let mut data = line.into_bytes();
    data.push(b'\r');
    send_bytes(ws, thread_id, data, cx);
}

/// Tell the daemon the grid size the pane fits. No-op until the terminal
/// exists; creation picks up the latest size from the VT state.
pub fn resize(ws: &mut Workspace, thread_id: ThreadId, cols: u16, rows: u16, cx: &mut Context<Workspace>) {
    let Some(t) = ws.terminals.get_mut(&thread_id) else { return };
    let Some(id) = t.id else { return };
    if t.size == (cols, rows) {
        return;
    }
    t.size = (cols, rows);
    let d = ws.daemon.clone();
    cx.spawn(async move |_, _| {
        let _ = d.call::<TerminalsResize>(TerminalsResizeParams { terminal_id: id, cols, rows }).await;
    })
    .detach();
}

pub fn handle_notification(ws: &mut Workspace, n: &RpcNotification, cx: &mut Context<Workspace>) {
    if n.method == TERMINAL_OUTPUT_NOTIFICATION {
        let Ok(p) = serde_json::from_value::<TerminalOutputNotification>(n.params.clone()) else { return };
        let Some((thread_id, t)) = ws.terminals.iter().find(|(_, t)| t.id == Some(p.terminal_id)) else { return };
        let thread_id = *thread_id;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&p.data) else { return };
        let reply = t.state.update(cx, |s, _| {
            s.feed(&bytes);
            s.take_pending_output()
        });
        // Replies to queries (device attributes, cursor position) go back to the process.
        send_bytes(ws, thread_id, reply, cx);
        cx.notify();
    } else if n.method == TERMINAL_EXITED_NOTIFICATION {
        let Ok(p) = serde_json::from_value::<TerminalExitedNotification>(n.params.clone()) else { return };
        if let Some(t) = ws.terminals.values_mut().find(|t| t.id == Some(p.terminal_id)) {
            t.exited = Some(p.exit_code);
        }
        cx.notify();
    }
}

pub fn render(ws: &mut Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    let Some(thread_id) = ws.model.selected_thread else {
        return v_flex().size_full().items_center().justify_center().child(div().text_sm().text_color(muted).child("Select a thread to open its terminal.")).into_any_element();
    };
    // Idempotent: covers switching threads while the tab is open.
    ensure_terminal(ws, cx);
    let Some(t) = ws.terminals.get(&thread_id) else {
        return v_flex().size_full().items_center().justify_center().child(div().text_sm().text_color(muted).child("Opening a terminal…")).into_any_element();
    };
    if let Some(err) = &t.error {
        return v_flex().size_full().items_center().justify_center().p_4().child(div().text_sm().text_color(muted).child(err.clone())).into_any_element();
    }

    let theme = cx.theme();
    let palette = Palette::for_theme(theme.is_dark(), theme.background, theme.foreground);
    let mono = theme.mono_font_family.clone();
    let mono_size = theme.mono_font_size;
    let border = theme.border;
    let exited = t.exited;

    let ws_for_input = cx.entity().downgrade();
    let ws_for_resize = cx.entity().downgrade();
    let element = TerminalElement::new(t.state.clone(), t.focus.clone())
        .font(mono, mono_size)
        .palette(palette)
        .on_input(move |bytes, _window, cx| {
            ws_for_input.update(cx, |ws, cx| send_bytes(ws, thread_id, bytes, cx)).ok();
        })
        .on_resize(move |cols, rows, _window, cx| {
            ws_for_resize.update(cx, |ws, cx| resize(ws, thread_id, cols, rows, cx)).ok();
        });

    v_flex()
        .size_full()
        .child(div().flex_1().min_h_0().w_full().child(element))
        .when_some(exited, |el, code| {
            el.child(
                div()
                    .px_3()
                    .py_1()
                    .border_t_1()
                    .border_color(border)
                    .text_xs()
                    .text_color(muted)
                    .child(format!("Process exited{}.", code.map(|c| format!(" with code {c}")).unwrap_or_default())),
            )
        })
        .into_any_element()
}

trait SizeTuple {
    fn into_tuple(self) -> (u16, u16);
}

impl SizeTuple for kybern_term::TermSize {
    fn into_tuple(self) -> (u16, u16) {
        (self.cols, self.rows)
    }
}
