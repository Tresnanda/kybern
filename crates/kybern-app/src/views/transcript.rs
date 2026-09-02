//! The thread pane: transcript rows rendered from the client model, plus the composer.

use std::rc::Rc;

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::message_scroller::MessageScroller;
use gpui_component::text::TextView;
use gpui_component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use kybern_protocol::*;

use crate::app::Workspace;
use crate::state::{BlockKind, TranscriptBlock, tool_display_name, tool_summary};
use crate::views::{format_duration, format_tokens};

pub fn render_pane(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let blocks: Rc<Vec<TranscriptBlock>> =
        Rc::new(ws.model.selected_thread.and_then(|id| ws.model.transcripts.get(&id)).map(|t| t.blocks.clone()).unwrap_or_default());
    let expanded = Rc::new(ws.expanded_tools.clone());
    let view = cx.entity();
    let has_thread = ws.model.selected_thread.is_some();
    let has_project = ws.model.selected_project.is_some();

    let body: AnyElement = if !has_project {
        empty_state("Add a project to begin", "Pick a folder, then write the first message to start a thread.", cx).into_any_element()
    } else if !has_thread {
        empty_state("New thread", "Describe what you want done. The agent starts in the selected project.", cx).into_any_element()
    } else if blocks.is_empty() {
        div().flex_1().into_any_element()
    } else {
        let blocks_for_render = blocks.clone();
        MessageScroller::new("transcript", ws.scroller.clone(), move |index, window, cx| {
            let Some(b) = blocks_for_render.get(index) else { return div().into_any_element() };
            render_block(b, expanded.contains(&b.id), &view, window, cx).into_any_element()
        })
        .with_list_style(StyleRefinement::default().px_4().py_6())
        .with_content_style(StyleRefinement::default().max_w(px(760.)).mx_auto().w_full())
        .with_bottom_fade(cx.theme().background)
        .jump_button(true)
        .with_jump_button_label("Jump to latest")
        .size_full()
        .into_any_element()
    };

    let composer = crate::views::composer::render(ws, window, cx);
    v_flex().size_full().child(div().flex_1().min_h_0().child(body)).child(composer).into_any_element()
}

fn eid(prefix: &str, id: &str) -> ElementId {
    ElementId::Name(SharedString::from(format!("{prefix}:{id}")))
}

fn empty_state(title: &str, body: &str, cx: &App) -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_1()
        .child(div().text_base().font_weight(FontWeight::MEDIUM).child(title.to_string()))
        .child(div().text_sm().text_color(cx.theme().muted_foreground).max_w(px(360.)).text_center().child(body.to_string()))
}

fn render_block(b: &TranscriptBlock, expanded: bool, view: &Entity<Workspace>, _window: &mut Window, cx: &mut App) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let row = div().w_full().pb_4();
    match &b.kind {
        BlockKind::User(message) => row.child(
            h_flex().w_full().justify_end().child(
                div()
                    .max_w(px(560.))
                    .px_3()
                    .py_2()
                    .rounded(px(12.))
                    .bg(cx.theme().muted)
                    .text_sm()
                    .child(TextView::markdown(eid("user", &b.id), message.plain_text()).selectable(true)),
            ),
        ),
        BlockKind::Assistant { text, thinking, complete } => {
            let id = b.id.clone();
            row.child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .when(!thinking.is_empty(), |el| {
                        el.child(
                            h_flex()
                                .gap_1()
                                .items_center()
                                .text_xs()
                                .text_color(muted)
                                .child(Icon::new(IconName::Bot).size_3())
                                .child(if *complete && !text.is_empty() { "Thought" } else { "Thinking" }),
                        )
                    })
                    .when(!text.is_empty(), |el| {
                        el.child(
                            div()
                                .text_sm()
                                .line_height(rems(1.6))
                                .child(TextView::markdown(eid("assistant", &id), text.clone()).selectable(true)),
                        )
                    })
                    .when(text.is_empty() && thinking.is_empty() && !*complete, |el| {
                        el.child(div().text_sm().text_color(muted).child("…"))
                    }),
            )
        }
        BlockKind::Tool { call, output_stream, output, is_error, complete } => {
            let summary = tool_summary(call);
            let verb = tool_display_name(&call.name).to_string();
            let block_id = b.id.clone();
            let color = if *is_error { cx.theme().danger } else { muted };
            let icon = if !*complete {
                Icon::new(IconName::LoaderCircle).size_3().text_color(muted)
            } else if *is_error {
                Icon::new(IconName::CircleX).size_3().text_color(cx.theme().danger)
            } else {
                Icon::new(IconName::Check).size_3().text_color(muted)
            };
            let detail = if expanded {
                let input = serde_json::to_string_pretty(&call.input).unwrap_or_default();
                let out = match output {
                    Some(v) => match v.get("content") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(other) if !other.is_null() => serde_json::to_string_pretty(other).unwrap_or_default(),
                        _ => serde_json::to_string_pretty(v).unwrap_or_default(),
                    },
                    None => output_stream.clone(),
                };
                Some(
                    v_flex()
                        .mt_1()
                        .ml_5()
                        .gap_2()
                        .child(mono_block(&input, cx))
                        .when(!out.trim().is_empty(), |el| el.child(mono_block(&out.chars().take(6000).collect::<String>(), cx))),
                )
            } else {
                None
            };
            row.pb_2().child(
                v_flex()
                    .child(
                        h_flex()
                            .id(eid("tool", &block_id))
                            .gap_2()
                            .items_center()
                            .cursor_pointer()
                            .rounded(px(4.))
                            .on_click({
                                let view = view.clone();
                                move |_, _, cx| {
                                    let id = block_id.clone();
                                    view.update(cx, |ws, cx| {
                                        if !ws.expanded_tools.remove(&id) {
                                            ws.expanded_tools.insert(id);
                                        }
                                        cx.notify();
                                    });
                                }
                            })
                            .child(icon)
                            .child(div().text_xs().text_color(color).child(verb))
                            .child(
                                div()
                                    .text_xs()
                                    .font_family(cx.theme().mono_font_family.clone())
                                    .text_color(cx.theme().foreground)
                                    .truncate()
                                    .child(summary),
                            ),
                    )
                    .children(detail),
            )
        }
        BlockKind::Approval { approval, decision } => row.child(approval_card(approval, decision.as_ref(), view, cx)),
        BlockKind::Notice { level, text } => {
            let color = match level {
                NoticeLevel::Error => cx.theme().danger,
                NoticeLevel::Warning => cx.theme().warning,
                NoticeLevel::Info => muted,
            };
            row.pb_2().child(
                h_flex().gap_2().items_center().text_xs().text_color(color).child(Icon::new(IconName::Info).size_3()).child(text.clone()),
            )
        }
        BlockKind::TurnEnd { stop_reason, usage, cost_usd, duration_ms, error } => {
            let turn_id = b.turn_id;
            let mut parts: Vec<String> = Vec::new();
            match error {
                Some(e) => parts.push(e.clone()),
                None => {
                    if *stop_reason == StopReason::Interrupted {
                        parts.push("Stopped".into());
                    }
                    if usage.input_tokens + usage.output_tokens > 0 {
                        parts.push(format!("{} in · {} out", format_tokens(usage.input_tokens), format_tokens(usage.output_tokens)));
                    }
                    if let Some(c) = cost_usd.filter(|c| *c > 0.0) {
                        parts.push(format!("${c:.3}"));
                    }
                    parts.push(format_duration(*duration_ms));
                }
            }
            let color = if error.is_some() { cx.theme().danger } else { muted };
            row.pb_6().child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .text_xs()
                    .text_color(color)
                    .font_family(cx.theme().mono_font_family.clone())
                    .child(parts.join("  ·  "))
                    .child(
                        Button::new(eid("revert", &b.id))
                            .ghost()
                            .xsmall()
                            .label("Revert")
                            .tooltip("Restore files and the conversation to before this turn")
                            .on_click({
                                let view = view.clone();
                                move |_, _, cx| {
                                    view.update(cx, |ws, cx| {
                                        if let Some(t) = ws.model.selected_thread {
                                            ws.revert_to(t, turn_id, cx);
                                        }
                                    });
                                }
                            }),
                    ),
            )
        }
        BlockKind::Reverted { commit } => row.pb_2().child(
            h_flex()
                .gap_2()
                .items_center()
                .text_xs()
                .text_color(muted)
                .child(Icon::new(IconName::Undo2).size_3())
                .child(format!("Reverted to {}", &commit[..commit.len().min(10)])),
        ),
    }
}

fn mono_block(text: &str, cx: &App) -> impl IntoElement {
    div()
        .w_full()
        .px_3()
        .py_2()
        .rounded(px(8.))
        .bg(cx.theme().muted)
        .text_xs()
        .font_family(cx.theme().mono_font_family.clone())
        .whitespace_normal()
        .child(text.to_string())
}

fn approval_card(a: &ApprovalRequest, decision: Option<&ApprovalDecision>, view: &Entity<Workspace>, cx: &App) -> impl IntoElement {
    let id = a.id;
    let pending = decision.is_none();
    let input = match a.input.get("command").and_then(|c| c.as_str()) {
        Some(c) => c.to_string(),
        None => serde_json::to_string_pretty(&a.input).unwrap_or_default(),
    };
    let title = match a.tool_name.as_str() {
        "Bash" | "bash" | "shell" | "execute" => "Run this command?".to_string(),
        "Write" | "Edit" | "MultiEdit" | "apply_patch" | "write" | "edit" => "Apply these changes?".to_string(),
        other => format!("Allow {other}?"),
    };
    let decided = decision.map(|d| match d {
        ApprovalDecision::AllowOnce => "Allowed",
        ApprovalDecision::AllowAlways => "Always allowed",
        ApprovalDecision::Deny { .. } => "Denied",
    });
    let respond = |view: Entity<Workspace>, d: ApprovalDecision| {
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            let d = d.clone();
            view.update(cx, |ws, cx| ws.respond_approval(id, d, cx));
        }
    };

    v_flex()
        .w_full()
        .gap_2()
        .p_3()
        .rounded(px(10.))
        .border_1()
        .border_color(if pending { cx.theme().warning.opacity(0.5) } else { cx.theme().border })
        .bg(cx.theme().background)
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                .child(div().text_xs().text_color(cx.theme().muted_foreground).child(a.summary.clone())),
        )
        .child(mono_block(&input.chars().take(2000).collect::<String>(), cx))
        .child(match decided {
            Some(label) => h_flex().text_xs().text_color(cx.theme().muted_foreground).child(label).into_any_element(),
            None => h_flex()
                .gap_2()
                .child(
                    Button::new(("allow", id.as_u128() as u64))
                        .primary()
                        .small()
                        .label("Allow")
                        .on_click(respond(view.clone(), ApprovalDecision::AllowOnce)),
                )
                .child(
                    Button::new(("always", id.as_u128() as u64))
                        .outline()
                        .small()
                        .label("Always allow")
                        .on_click(respond(view.clone(), ApprovalDecision::AllowAlways)),
                )
                .child(
                    Button::new(("deny", id.as_u128() as u64))
                        .ghost()
                        .small()
                        .label("Deny")
                        .on_click(respond(view.clone(), ApprovalDecision::Deny { reason: None })),
                )
                .into_any_element(),
        })
}
