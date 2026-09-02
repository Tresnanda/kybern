//! kybern desktop client. Build check skeleton; the real shell replaces this.

use gpui::*;
use gpui_component::{Root, ActiveTheme as _};

pub struct App;

impl Render for App {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().items_center().justify_center().text_color(cx.theme().foreground).child("kybern")
    }
}

fn main() {
    gpui_platform::application().with_assets(gpui_component_assets::Assets).run(move |cx| {
        gpui_component::init(cx);
        cx.spawn(async move |cx| {
            cx.open_window(WindowOptions::default(), |window, cx| {
                let view = cx.new(|_| App);
                cx.new(|cx| Root::new(view, window, cx).bg(cx.theme().background))
            })
            .expect("open window");
        })
        .detach();
    });
}
