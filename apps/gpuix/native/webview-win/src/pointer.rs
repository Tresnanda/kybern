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

#[cfg(test)]
mod tests {
    use super::*;

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
