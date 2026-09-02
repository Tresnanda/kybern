//! kybern desktop client.

mod app;
mod daemon;
mod keymap;
mod state;
mod views;

use gpui::*;
use gpui_component::{Root, TitleBar};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    gpui_platform::application().with_assets(gpui_component_assets::Assets).run(move |cx| {
        gpui_component::init(cx);
        cx.set_app_identity("dev.kybern.app", "kybern");
        app::init_actions(cx);
        keymap::install(cx, kybern_client::Endpoint::data_dir(None).as_deref());
        app::init_themes(cx, kybern_client::Endpoint::data_dir(None).as_deref());
        // Do not steal focus on launch; the user asked for the app, the window appears where they are.
        if std::env::var_os("KYBERN_NO_ACTIVATE").is_none() {
            cx.activate(true);
        }

        let daemon = match daemon::Daemon::connect_or_spawn() {
            Ok(d) => std::sync::Arc::new(d),
            Err(e) => {
                eprintln!("kybern: {e:#}");
                std::process::exit(1);
            }
        };

        let size = size(px(1360.), px(880.));
        cx.spawn(async move |cx| {
            let bounds = cx.update(|cx| Bounds::centered(None, size, cx));
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(Size { width: px(720.), height: px(480.) }),
                ..TitleBar::window_options()
            };
            let window = cx.open_window(options, |window, cx| {
                let view = cx.new(|cx| app::Workspace::new(daemon.clone(), window, cx));
                cx.set_global(views::composer::WorkspaceHandle(view.clone()));
                cx.new(|cx| Root::new(view, window, cx))
            })?;
            window.update(cx, |_, window, _| {
                if std::env::var_os("KYBERN_NO_ACTIVATE").is_none() {
                    window.activate_window();
                }
                window.set_window_title("kybern");
            })?;
            anyhow::Ok(())
        })
        .detach();
    });
}
