pub mod changes;
pub mod composer;
pub mod sidebar;
pub mod terminal;
pub mod transcript;

use gpui::*;
use gpui_component::ActiveTheme as _;
use kybern_protocol::ThreadStatus;

/// Status color for a thread, or none for idle.
pub fn status_color(status: ThreadStatus, cx: &App) -> Option<Hsla> {
    match status {
        ThreadStatus::Idle | ThreadStatus::Archived => None,
        ThreadStatus::Running => Some(cx.theme().blue),
        ThreadStatus::AwaitingApproval => Some(cx.theme().warning),
        ThreadStatus::Failed => Some(cx.theme().danger),
    }
}

pub fn status_label(status: ThreadStatus) -> Option<&'static str> {
    match status {
        ThreadStatus::Idle | ThreadStatus::Archived => None,
        ThreadStatus::Running => Some("Working"),
        ThreadStatus::AwaitingApproval => Some("Needs approval"),
        ThreadStatus::Failed => Some("Failed"),
    }
}

/// A 6px status dot.
pub fn dot(color: Hsla) -> Div {
    div().size(px(6.)).rounded_full().bg(color).flex_shrink_0()
}

pub fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{}k", n / 1000)
    } else if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

pub fn format_duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else if ms < 60_000 {
        format!("{:.1} s", ms as f64 / 1000.0)
    } else {
        format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1000)
    }
}
