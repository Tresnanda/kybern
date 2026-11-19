//! Who gets a mouse message while buttons are held: the pointer filter's press rules, platform independent so drags
//! are unit-tested anywhere (`host.rs` `Host::pointer` applies them).
//!
//! A press belongs to whatever it started on until every button is up: a page keeps a drag that leaves it (selections,
//! sliders), and GPUI keeps one that crosses a page (a text selection, a split's divider, a scrollbar). A page never
//! sees an up, a move with buttons held or a second button without its own first down.

/// The owner of the press in progress.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Owner {
    #[default]
    None,
    Gpui,
    Page(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Down,
    Up,
    Move,
    Wheel,
}

/// Where one message goes.
#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    Gpui,
    Page(String),
}

/// `buttons` is whether any button is still held after this message (`MK_*` mouse buttons in `wParam`, `& 0x73`);
/// `hit` the page under the pointer, if any.
pub fn route(owner: &mut Owner, kind: Kind, buttons: bool, hit: Option<&str>) -> Route {
    // A move or wheel with no button held ends a press whose up never arrived (capture taken away, a modal loop).
    if !buttons && matches!(kind, Kind::Move | Kind::Wheel) {
        *owner = Owner::None;
    }
    let routed = match (&*owner, kind) {
        (Owner::Gpui, _) => Route::Gpui,
        (Owner::Page(id), _) => Route::Page(id.clone()),
        (Owner::None, Kind::Down) => match hit {
            Some(id) => {
                *owner = Owner::Page(id.to_owned());
                Route::Page(id.to_owned())
            }
            None => {
                *owner = Owner::Gpui;
                Route::Gpui
            }
        },
        // An up without a down we saw, or a drag that began outside the window or before the page was placed.
        (Owner::None, Kind::Up) => Route::Gpui,
        (Owner::None, Kind::Move) if buttons => Route::Gpui,
        (Owner::None, _) => hit.map_or(Route::Gpui, |id| Route::Page(id.to_owned())),
    };
    if kind == Kind::Up && !buttons {
        *owner = Owner::None;
    }
    routed
}

// ---- The wheel over a visual (`webview.m` `routeWheel`) ----
//
// A visual's frame fits its page, which never scrolls itself, so the wheel over it goes to GPUI (the chat scrolls). Only
// a gesture that starts over one of the page's own scroll areas, in a direction that area can still go, goes to the page;
// Chromium then keeps that area for the gesture. Windows wheels have no phases: a pause of `WHEEL_GAP_MS` starts a new
// gesture, and a gesture keeps its owner when a page slides under the pointer.

/// Room in a scroll area, as the page reports it (`bootstrap.js`): up, down, left, right.
pub const UP: u8 = 1;
pub const DOWN: u8 = 2;
pub const LEFT: u8 = 4;
pub const RIGHT: u8 = 8;
pub const WHEEL_GAP_MS: u64 = 300;

/// The room a wheel message needs: `WM_MOUSEWHEEL` positive scrolls up, `WM_MOUSEHWHEEL` positive scrolls right.
pub fn wheel_need(horizontal: bool, delta: i32) -> u8 {
    match (horizontal, delta > 0) {
        (false, true) => UP,
        (false, false) => DOWN,
        (true, true) => RIGHT,
        (true, false) => LEFT,
    }
}

/// Whether a point in the page's CSS pixels is over one of its scroll areas (`[x, y, width, height, room]`) with `need`.
pub fn page_takes(scrollers: &[[f64; 5]], x: f64, y: f64, need: u8) -> bool {
    scrollers.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3] && (r[4] as u8) & need != 0)
}

/// The gesture in progress: who owns it (`None` GPUI) and when its last message came.
#[derive(Debug, Default)]
pub struct WheelLatch {
    owner: Option<Option<String>>,
    last_ms: Option<u64>,
}

/// One wheel message: `page` is the visual under the pointer and whether it takes a new gesture there.
pub fn route_wheel(latch: &mut WheelLatch, now_ms: u64, page: Option<(&str, bool)>) -> Route {
    let starts = latch.last_ms.is_none_or(|last| now_ms.saturating_sub(last) > WHEEL_GAP_MS);
    latch.last_ms = Some(now_ms);
    if starts || latch.owner.is_none() {
        latch.owner = Some(page.filter(|(_, takes)| *takes).map(|(id, _)| id.to_owned()));
    }
    match (&latch.owner, page) {
        (Some(Some(owner)), Some((id, _))) if owner == id => Route::Page(id.to_owned()),
        _ => Route::Gpui,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wheel_over_a_page_scrolls_the_chat_except_over_its_scroll_areas() {
        let areas = [[10.0, 20.0, 100.0, 50.0, (DOWN) as f64]];
        assert!(page_takes(&areas, 50.0, 30.0, DOWN));
        assert!(!page_takes(&areas, 50.0, 30.0, UP), "at its top the list cannot scroll up: the chat does");
        assert!(!page_takes(&areas, 5.0, 30.0, DOWN), "beside the list");
        assert_eq!(wheel_need(false, 120), UP);
        assert_eq!(wheel_need(false, -120), DOWN);
        assert_eq!(wheel_need(true, 120), RIGHT);
        let mut latch = WheelLatch::default();
        assert_eq!(route_wheel(&mut latch, 0, Some(("a", false))), Route::Gpui);
        assert_eq!(route_wheel(&mut latch, 1000, Some(("a", true))), page("a"), "a new gesture over the list");
        assert_eq!(route_wheel(&mut latch, 1050, Some(("a", false))), page("a"), "the list reached its end: the gesture stays");
        assert_eq!(route_wheel(&mut latch, 1500, Some(("a", false))), Route::Gpui, "a new gesture at its end moves the chat");
    }

    #[test]
    fn a_gesture_on_the_chat_stays_with_it_when_a_page_slides_under() {
        let mut latch = WheelLatch::default();
        assert_eq!(route_wheel(&mut latch, 0, None), Route::Gpui);
        assert_eq!(route_wheel(&mut latch, 40, Some(("a", true))), Route::Gpui);
        assert_eq!(route_wheel(&mut latch, 80, Some(("b", true))), Route::Gpui);
        assert_eq!(route_wheel(&mut latch, 500, Some(("a", true))), page("a"));
        assert_eq!(route_wheel(&mut latch, 520, Some(("b", true))), Route::Gpui, "another page mid-gesture");
    }

    fn page(id: &str) -> Route {
        Route::Page(id.to_owned())
    }

    #[test]
    fn a_gpui_drag_across_a_page_stays_with_gpui() {
        let mut owner = Owner::None;
        assert_eq!(route(&mut owner, Kind::Down, true, None), Route::Gpui);
        assert_eq!(owner, Owner::Gpui);
        // Across the page and out the other side: no move, wheel or up reaches it.
        assert_eq!(route(&mut owner, Kind::Move, true, Some("a")), Route::Gpui);
        assert_eq!(route(&mut owner, Kind::Wheel, true, Some("a")), Route::Gpui);
        assert_eq!(route(&mut owner, Kind::Down, true, Some("a")), Route::Gpui, "a second button over the page");
        assert_eq!(route(&mut owner, Kind::Up, true, Some("a")), Route::Gpui, "one of two buttons up");
        assert_eq!(route(&mut owner, Kind::Up, false, Some("a")), Route::Gpui, "the last up, over the page");
        assert_eq!(owner, Owner::None);
        assert_eq!(route(&mut owner, Kind::Move, false, Some("a")), page("a"), "hover resumes after the release");
    }

    #[test]
    fn a_page_keeps_its_drag_outside_it() {
        let mut owner = Owner::None;
        assert_eq!(route(&mut owner, Kind::Down, true, Some("a")), page("a"));
        assert_eq!(route(&mut owner, Kind::Move, true, None), page("a"));
        assert_eq!(route(&mut owner, Kind::Move, true, Some("b")), page("a"));
        assert_eq!(route(&mut owner, Kind::Up, false, None), page("a"), "its up, wherever it lands");
        assert_eq!(route(&mut owner, Kind::Move, false, None), Route::Gpui);
    }

    #[test]
    fn a_page_never_gets_an_up_or_a_drag_it_did_not_start() {
        let mut owner = Owner::None;
        assert_eq!(route(&mut owner, Kind::Up, false, Some("a")), Route::Gpui);
        assert_eq!(route(&mut owner, Kind::Move, true, Some("a")), Route::Gpui, "a drag that began outside the window");
        assert_eq!(owner, Owner::None);
    }

    #[test]
    fn a_lost_up_ends_the_press() {
        let mut owner = Owner::None;
        route(&mut owner, Kind::Down, true, None);
        // The up went elsewhere (capture lost); the next plain move routes by position again.
        assert_eq!(route(&mut owner, Kind::Move, false, Some("a")), page("a"));
        route(&mut owner, Kind::Down, true, Some("a"));
        assert_eq!(route(&mut owner, Kind::Wheel, false, None), Route::Gpui);
        assert_eq!(owner, Owner::None);
    }
}
