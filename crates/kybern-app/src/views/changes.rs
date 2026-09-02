//! Right panel: Changes (diff) and Terminal tabs.

use gpui::*;
use gpui_component::input::Editor;
use gpui_component::tab::TabBar;
use gpui_component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use kybern_protocol::*;

use crate::app::{RightTab, Workspace};

pub fn render_right_panel(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let tab_ix = match ws.right_tab {
        RightTab::Changes => 0,
        RightTab::Terminal => 1,
    };
    let content: AnyElement = match ws.right_tab {
        RightTab::Changes => render_changes(ws, window, cx).into_any_element(),
        RightTab::Terminal => crate::views::terminal::render(ws, window, cx).into_any_element(),
    };
    v_flex()
        .size_full()
        .border_l_1()
        .border_color(cx.theme().border)
        .child(
            TabBar::new("right-tabs")
                .underline()
                .with_size(gpui_component::Size::Small)
                .selected_index(tab_ix)
                .on_click(cx.listener(|this, ix: &usize, _, cx| {
                    this.right_tab = if *ix == 0 { RightTab::Changes } else { RightTab::Terminal };
                    if this.right_tab == RightTab::Terminal {
                        crate::views::terminal::ensure_terminal(this, cx);
                    }
                    cx.notify();
                }))
                .child("Changes")
                .child("Terminal"),
        )
        .child(div().flex_1().min_h_0().child(content))
        .into_any_element()
}

fn render_changes(ws: &mut Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let Some(diff) = ws.diff.clone() else {
        let text = if ws.model.selected_thread.is_none() {
            "Changes made in this thread show up here."
        } else if ws.diff_loading {
            "Loading changes"
        } else {
            "No changes yet."
        };
        return v_flex().size_full().items_center().justify_center().child(div().text_sm().text_color(muted).child(text)).into_any_element();
    };
    if diff.files.is_empty() {
        return v_flex().size_full().items_center().justify_center().child(div().text_sm().text_color(muted).child("No changes yet.")).into_any_element();
    }
    let mono = cx.theme().mono_font_family.clone();
    let files = diff.files.iter().map(|f| {
        let status_color = match f.status {
            FileStatus::Added | FileStatus::Copied => cx.theme().success,
            FileStatus::Deleted => cx.theme().danger,
            _ => cx.theme().foreground,
        };
        h_flex()
            .h(px(24.))
            .px_3()
            .gap_2()
            .items_center()
            .text_xs()
            .child(div().flex_1().min_w_0().truncate().font_family(mono.clone()).text_color(status_color).child(f.path.clone()))
            .child(div().text_color(cx.theme().success).child(format!("+{}", f.additions)))
            .child(div().text_color(cx.theme().danger).child(format!("-{}", f.deletions)))
    });
    v_flex()
        .size_full()
        .child(div().id("files").max_h(px(200.)).overflow_y_scroll().py_1().children(files))
        .child(div().flex_1().min_h_0().border_t_1().border_color(cx.theme().border).child(Editor::new(&ws.diff_editor).readonly(true).bordered(false).appearance(false).text_xs().size_full()))
        .into_any_element()
}
