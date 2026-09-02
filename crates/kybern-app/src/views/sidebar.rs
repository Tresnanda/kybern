//! Title bar and the projects/threads sidebar.

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::menu::{ContextMenuExt as _, PopupMenu};
use gpui_component::{ActiveTheme as _, Icon, IconName, Sizable as _, TitleBar, h_flex, v_flex};
use kybern_protocol::*;

use crate::app::Workspace;
use crate::views::{dot, status_color};

pub fn render_title_bar(ws: &mut Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let title = ws.selected_thread().map(|t| t.title.clone()).unwrap_or_else(|| "New thread".into());
    let project = ws.model.selected_project.and_then(|p| ws.model.projects.get(&p)).map(|p| p.name.clone());
    let connection = ws.connection_line();

    TitleBar::new()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .overflow_hidden()
                .when_some(project, |el, p| el.child(div().text_xs().text_color(cx.theme().muted_foreground).child(p)))
                .when(ws.model.selected_thread.is_some() || ws.model.selected_project.is_some(), |el| {
                    el.child(div().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(title))
                })
                .when_some(connection, |el, c| el.child(div().text_xs().text_color(cx.theme().warning).child(c))),
        )
        .child(
            h_flex()
                .items_center()
                .justify_end()
                .px_2()
                .gap_1()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    Button::new("toggle-sidebar")
                        .ghost()
                        .xsmall()
                        .icon(if ws.show_sidebar { IconName::PanelLeftClose } else { IconName::PanelLeftOpen })
                        .tooltip("Toggle sidebar")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_sidebar = !this.show_sidebar;
                            cx.notify();
                        })),
                )
                .child(
                    Button::new("toggle-right")
                        .ghost()
                        .xsmall()
                        .icon(if ws.show_right { IconName::PanelRightClose } else { IconName::PanelRightOpen })
                        .tooltip("Toggle changes and terminal")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_right = !this.show_right;
                            cx.notify();
                        })),
                ),
        )
        .into_any_element()
}

pub fn render(ws: &mut Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme();
    let sidebar_bg = theme.sidebar;
    let muted = theme.muted_foreground;
    let projects: Vec<Project> = ws.model.projects.values().cloned().collect();

    let mut groups: Vec<AnyElement> = Vec::new();
    for p in &projects {
        let threads: Vec<Thread> = ws.model.threads_for_project(p.id).into_iter().cloned().collect();
        let project_id = p.id;
        let is_drafting = ws.model.selected_thread.is_none() && ws.model.selected_project == Some(project_id);
        let mut group = v_flex().gap_px().child(
            h_flex()
                .id(("project", project_id.as_u128() as u64))
                .h(px(28.))
                .px_2()
                .items_center()
                .justify_between()
                .group("project-row")
                .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(muted).truncate().child(p.name.clone()))
                .child(
                    Button::new(("new-thread", project_id.as_u128() as u64))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Plus)
                        .tooltip("New thread")
                        .on_click(cx.listener(move |this, _, _, cx| this.start_draft(project_id, cx))),
                ),
        );
        if is_drafting {
            group = group.child(thread_row("draft", "New thread", None, true, cx.theme().accent, cx.theme().accent_foreground, None));
        }
        for t in threads {
            let id = t.id;
            let selected = ws.model.selected_thread == Some(id);
            let color = status_color(t.status, cx);
            let row = thread_row(
                ("thread", id.as_u128() as u64),
                &t.title,
                color,
                selected,
                cx.theme().accent,
                cx.theme().accent_foreground,
                if t.pinned { Some(IconName::Star) } else { None },
            )
            .on_click(cx.listener(move |this, _, _, cx| this.select_thread(id, cx)))
            .context_menu(move |menu: PopupMenu, _, _| {
                menu.menu("Archive thread", Box::new(crate::app::ArchiveThread))
                    .menu("Create pull request", Box::new(crate::app::CreatePullRequest))
            });
            group = group.child(row);
        }
        groups.push(group.into_any_element());
    }

    let empty = ws.model.projects.is_empty();

    v_flex()
        .size_full()
        .bg(sidebar_bg)
        .border_r_1()
        .border_color(cx.theme().sidebar_border)
        .child(div().id("sidebar-scroll").flex_1().min_h_0().overflow_y_scroll().py_2().px_2().child(
            v_flex().gap_4().children(groups).when(empty, |el| {
                el.child(
                    v_flex()
                        .px_2()
                        .pt_6()
                        .gap_2()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("No projects yet"))
                        .child(div().text_xs().text_color(muted).child("A project is a folder an agent works in.")),
                )
            }),
        ))
        .child(
            h_flex().p_2().gap_1().child(
                Button::new("add-project")
                    .ghost()
                    .small()
                    .icon(IconName::FolderOpen)
                    .label("Add project")
                    .on_click(cx.listener(|this, _, _, cx| this.add_project(cx))),
            ),
        )
        .into_any_element()
}

fn thread_row(
    id: impl Into<ElementId>,
    title: &str,
    status: Option<Hsla>,
    selected: bool,
    accent: Hsla,
    accent_fg: Hsla,
    suffix: Option<IconName>,
) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(28.))
        .px_2()
        .gap_2()
        .rounded(px(6.))
        .cursor_pointer()
        .items_center()
        .when(selected, |el| el.bg(accent).text_color(accent_fg))
        .when(!selected, |el| el.hover(|s| s.bg(accent.opacity(0.5))))
        .child(div().w(px(6.)).flex_shrink_0().children(status.map(dot)))
        .child(div().flex_1().min_w_0().text_sm().truncate().child(title.to_string()))
        .when_some(suffix, |el, icon| el.child(Icon::new(icon).size_3().text_color(accent_fg.opacity(0.6))))
}
