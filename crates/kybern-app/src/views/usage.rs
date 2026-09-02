//! Usage dialog: tokens and cost by provider.

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::{ActiveTheme as _, WindowExt as _, h_flex, v_flex};

use crate::app::Workspace;
use crate::views::format_tokens;

pub fn open(ws: &mut Workspace, _view: Entity<Workspace>, window: &mut Window, cx: &mut Context<Workspace>) {
    let Some(usage) = ws.usage.clone() else { return };
    window.open_dialog(cx, move |dialog, _, cx| {
        let mono = cx.theme().mono_font_family.clone();
        let muted = cx.theme().muted_foreground;
        let header = h_flex()
            .gap_4()
            .text_xs()
            .text_color(muted)
            .child(div().w(px(140.)).child("Provider"))
            .child(div().w(px(60.)).text_right().child("Turns"))
            .child(div().w(px(80.)).text_right().child("Input"))
            .child(div().w(px(80.)).text_right().child("Output"))
            .child(div().w(px(80.)).text_right().child("Cached"))
            .child(div().w(px(80.)).text_right().child("Cost"));
        let rows = usage.rows.iter().chain(std::iter::once(&usage.total)).map(|r| {
            let is_total = r.key == "total";
            h_flex()
                .gap_4()
                .text_sm()
                .font_family(mono.clone())
                .when(is_total, |el| el.font_weight(FontWeight::SEMIBOLD).pt_2())
                .child(div().w(px(140.)).child(if is_total { "Total".to_string() } else { r.key.clone() }))
                .child(div().w(px(60.)).text_right().child(r.turns.to_string()))
                .child(div().w(px(80.)).text_right().child(format_tokens(r.usage.input_tokens)))
                .child(div().w(px(80.)).text_right().child(format_tokens(r.usage.output_tokens)))
                .child(div().w(px(80.)).text_right().child(format_tokens(r.usage.cache_read_tokens + r.usage.cache_write_tokens)))
                .child(div().w(px(80.)).text_right().child(format!("${:.2}", r.cost_usd)))
        });
        dialog.title("Usage").w(px(640.)).overlay(true).overlay_closable(true).close_button(true).child(
            v_flex().gap_2().child(header).children(rows).child(
                div()
                    .pt_3()
                    .text_xs()
                    .text_color(muted)
                    .child("Costs come from the providers where they report one. Cursor and Oh My Pi report none."),
            ),
        )
    });
}
