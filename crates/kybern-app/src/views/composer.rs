//! The message composer: text area plus provider, mode, worktree and send controls.

use gpui::*;
use gpui::prelude::FluentBuilder as _;
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::input::Textarea;
use gpui_component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_component::{ActiveTheme as _, Disableable as _, IconName, Sizable as _, h_flex, v_flex};
use kybern_protocol::*;

use crate::app::Workspace;

pub fn mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised => "Supervised",
        PermissionMode::AcceptEdits => "Accept edits",
        PermissionMode::Auto => "Auto",
        PermissionMode::FullAccess => "Full access",
    }
}

pub fn render(ws: &mut Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let running = ws.is_running();
    let drafting = ws.model.selected_thread.is_none();
    let provider = ws.composer_settings.provider;
    let mode = ws.composer_settings.mode;
    let worktree = ws.composer_settings.worktree;
    let providers: Vec<(ProviderKind, bool, Vec<PermissionMode>)> = ws.model.providers.iter().map(|p| (p.kind, p.available, p.supported_permission_modes.clone())).collect();
    let supported_modes: Vec<PermissionMode> = providers.iter().find(|(k, _, _)| *k == provider).map(|(_, _, m)| m.clone()).unwrap_or_else(|| PermissionMode::ALL.to_vec());
    let has_text = !ws.composer.read(cx).value().trim().is_empty();
    let project_is_git = ws.model.selected_project.and_then(|p| ws.model.projects.get(&p)).is_some_and(|p| p.is_git);
    let can_send = has_text && !ws.sending && ws.model.selected_project.is_some();

    let border = cx.theme().border;
    let bg = cx.theme().background;
    let muted = cx.theme().muted_foreground;

    let provider_button = Button::new("provider")
        .ghost()
        .xsmall()
        .label(provider.display_name())
        .disabled(!drafting)
        .dropdown_caret(drafting)
        .tooltip(if drafting { "Agent for this thread" } else { "Agents are fixed per thread" })
        .dropdown_menu(move |menu: PopupMenu, window, cx| {
            let mut menu = menu.min_w(px(200.));
            for (kind, available, _) in providers.clone() {
                menu = menu.item(
                    PopupMenuItem::new(kind.display_name())
                        .checked(kind == provider)
                        .disabled(!available)
                        .on_click(window.listener_for(&workspace_entity(cx), move |this: &mut Workspace, _, _, cx| {
                            this.composer_settings.provider = kind;
                            cx.notify();
                        })),
                );
            }
            menu
        });

    let mode_button = Button::new("mode")
        .ghost()
        .xsmall()
        .label(mode_label(mode))
        .dropdown_caret(true)
        .tooltip("Permission mode")
        .dropdown_menu(move |menu: PopupMenu, window, cx| {
            let mut menu = menu.min_w(px(200.));
            for m in PermissionMode::ALL {
                let supported = supported_modes.contains(&m);
                menu = menu.item(
                    PopupMenuItem::new(mode_label(m))
                        .checked(m == mode)
                        .disabled(!supported)
                        .on_click(window.listener_for(&workspace_entity(cx), move |this: &mut Workspace, _, _, cx| this.set_thread_mode(m, cx))),
                );
            }
            menu
        });

    let worktree_button = Button::new("worktree")
        .ghost()
        .xsmall()
        .icon(IconName::GalleryVerticalEnd)
        .toggled(worktree)
        .disabled(!drafting || !project_is_git)
        .tooltip(if project_is_git { "Work in a separate git worktree" } else { "Worktrees need a git repository" })
        .on_click(cx.listener(|this, _, _, cx| {
            this.composer_settings.worktree = !this.composer_settings.worktree;
            cx.notify();
        }));

    let primary = if running {
        Button::new("stop").small().outline().icon(IconName::Pause).label("Stop").tooltip("Stop the current turn (⌘.)").on_click(cx.listener(|this, _, _, cx| this.interrupt(cx)))
    } else {
        Button::new("send")
            .small()
            .primary()
            .icon(IconName::ArrowUp)
            .disabled(!can_send)
            .loading(ws.sending)
            .tooltip("Send (Enter)")
            .on_click(cx.listener(|this, _, window, cx| {
                let text = this.composer.read(cx).value().trim().to_string();
                if !text.is_empty() {
                    this.composer.update(cx, |s, cx| s.set_value("", window, cx));
                    this.send_text(text, cx);
                }
            }))
    };

    v_flex()
        .w_full()
        .max_w(px(760.))
        .mx_auto()
        .px_4()
        .pb_4()
        .child(
            v_flex()
                .w_full()
                .rounded(px(12.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .shadow_sm()
                .child(div().px_3().pt_3().pb_1().child(Textarea::new(&ws.composer).appearance(false).bordered(false)))
                .child(
                    h_flex()
                        .px_2()
                        .pb_2()
                        .items_center()
                        .justify_between()
                        .child(h_flex().gap_1().child(provider_button).child(mode_button).child(worktree_button))
                        .child(h_flex().gap_2().items_center().when(running, |el| el.child(div().text_xs().text_color(muted).child("Working"))).child(primary)),
                ),
        )
        .into_any_element()
}

/// The workspace entity, for menu item handlers that only get `&mut App`.
pub fn workspace_entity(cx: &App) -> Entity<Workspace> {
    cx.global::<WorkspaceHandle>().0.clone()
}

pub struct WorkspaceHandle(pub Entity<Workspace>);
impl Global for WorkspaceHandle {}
