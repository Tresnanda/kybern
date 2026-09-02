//! Terminal tab. First version: raw output with ANSI stripped, in a mono
//! scroller, plus a single-line input. A real VT renderer replaces this.

use base64::Engine;
use gpui::*;
use gpui::prelude::FluentBuilder as _;
use gpui_component::input::Input;
use gpui_component::{ActiveTheme as _, Sizable as _, v_flex};
use kybern_protocol::methods::*;
use kybern_protocol::*;

use crate::app::Workspace;

pub struct TerminalView {
    pub id: Option<TerminalId>,
    pub text: String,
    pub exited: Option<Option<i32>>,
    pub creating: bool,
}

pub fn ensure_terminal(ws: &mut Workspace, cx: &mut Context<Workspace>) {
    let Some(thread_id) = ws.model.selected_thread else { return };
    let entry = ws.terminals.entry(thread_id).or_insert(TerminalView { id: None, text: String::new(), exited: None, creating: false });
    if entry.id.is_some() || entry.creating {
        return;
    }
    entry.creating = true;
    let d = ws.daemon.clone();
    cx.spawn(async move |this, cx| {
        let r = d.call::<TerminalsCreate>(TerminalsCreateParams { thread_id: Some(thread_id), cwd: None, cols: 100, rows: 30, command: None }).await;
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
                    Ok(info) => t.id = Some(info.id),
                    Err(e) => t.text = format!("Unable to open a terminal. {e}"),
                }
            }
            cx.notify();
        })
        .ok();
    })
    .detach();
}

pub fn send_line(ws: &mut Workspace, line: String, cx: &mut Context<Workspace>) {
    let Some(thread_id) = ws.model.selected_thread else { return };
    let Some(id) = ws.terminals.get(&thread_id).and_then(|t| t.id) else { return };
    let mut data = line;
    data.push('\n');
    let d = ws.daemon.clone();
    cx.spawn(async move |_, _| {
        let _ = d.call::<TerminalsInput>(TerminalsInputParams { terminal_id: id, data: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()) }).await;
    })
    .detach();
}

pub fn handle_notification(ws: &mut Workspace, n: &RpcNotification, cx: &mut Context<Workspace>) {
    if n.method == TERMINAL_OUTPUT_NOTIFICATION {
        let Ok(p) = serde_json::from_value::<TerminalOutputNotification>(n.params.clone()) else { return };
        let Some(t) = ws.terminals.values_mut().find(|t| t.id == Some(p.terminal_id)) else { return };
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&p.data) {
            t.text.push_str(&strip_ansi(&String::from_utf8_lossy(&bytes)));
            if t.text.len() > 200_000 {
                let cut = t.text.len() - 150_000;
                t.text.drain(..cut);
            }
        }
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
    let (text, exited) = ws.terminals.get(&thread_id).map(|t| (t.text.clone(), t.exited)).unwrap_or_default();
    let mono = cx.theme().mono_font_family.clone();
    v_flex()
        .size_full()
        .child(
            div()
                .id("term-out")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p_3()
                .text_xs()
                .font_family(mono)
                .whitespace_normal()
                .child(text)
                .when_some(exited, |el, code| el.child(div().text_color(muted).child(format!("[process exited{}]", code.map(|c| format!(" with code {c}")).unwrap_or_default())))),
        )
        .child(div().p_2().border_t_1().border_color(cx.theme().border).child(Input::new(&ws.terminal_input).appearance(true).small()))
        .into_any_element()
}

/// Remove CSI/OSC escape sequences and carriage-return noise.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {}
                None => {}
            },
            '\r' => {}
            '\u{7}' => {}
            _ => out.push(c),
        }
    }
    out
}
