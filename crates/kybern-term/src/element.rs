//! GPUI element that paints a [`TerminalState`] grid and routes input.
//!
//! Layout: every frame the element measures the mono font's advance width and
//! derives the number of columns/rows that fit its bounds, resizes the VT
//! state to match, and (deferred, outside the render pass) tells the app via
//! `on_resize` so it can resize the PTY. Painting batches runs of cells with
//! identical style into single shaped lines, one background quad per
//! contiguous coloured span, then the cursor on top.
//!
//! Input: when the element's focus handle is focused, key presses are mapped
//! to bytes (see [`crate::keys`]) and handed to `on_input`; text the platform
//! composes (IME, dead keys) arrives through a minimal `InputHandler`. The
//! wheel scrolls the viewport through scrollback, or is translated to arrow
//! keys on the alternate screen.

use std::ops::Range;
use std::rc::Rc;

use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor};
use gpui::*;

use crate::colors::Palette;
use crate::keys::{keystroke_to_bytes, paste_bytes};
use crate::state::TerminalState;

pub type InputFn = Rc<dyn Fn(Vec<u8>, &mut Window, &mut App)>;
pub type ResizeFn = Rc<dyn Fn(u16, u16, &mut Window, &mut App)>;

/// Renders a terminal grid. Build one per frame in your view's `render`.
pub struct TerminalElement {
    state: Entity<TerminalState>,
    focus: FocusHandle,
    interactivity: Interactivity,
    font_family: SharedString,
    font_size: Pixels,
    line_height_factor: f32,
    padding: Pixels,
    palette: Palette,
    on_input: Option<InputFn>,
    on_resize: Option<ResizeFn>,
}

impl TerminalElement {
    pub fn new(state: Entity<TerminalState>, focus: FocusHandle) -> Self {
        let mut interactivity = Interactivity::new();
        interactivity.element_id = Some(ElementId::Name("kybern-terminal".into()));
        let this = Self {
            state,
            focus: focus.clone(),
            interactivity,
            font_family: "monospace".into(),
            font_size: px(13.),
            line_height_factor: 1.35,
            padding: px(8.),
            palette: Palette::dark(),
            on_input: None,
            on_resize: None,
        };
        this.track_focus(&focus)
    }

    pub fn font(mut self, family: impl Into<SharedString>, size: Pixels) -> Self {
        self.font_family = family.into();
        self.font_size = size;
        self
    }

    pub fn line_height_factor(mut self, factor: f32) -> Self {
        self.line_height_factor = factor.max(1.);
        self
    }

    pub fn padding(mut self, padding: Pixels) -> Self {
        self.padding = padding;
        self
    }

    pub fn palette(mut self, palette: Palette) -> Self {
        self.palette = palette;
        self
    }

    /// Bytes the user typed (or pasted), to be written to the PTY.
    pub fn on_input(mut self, f: impl Fn(Vec<u8>, &mut Window, &mut App) + 'static) -> Self {
        self.on_input = Some(Rc::new(f));
        self
    }

    /// The grid size that fits the element changed. Called after the frame
    /// (via `Window::defer`), so it is safe to update entities from it.
    pub fn on_resize(mut self, f: impl Fn(u16, u16, &mut Window, &mut App) + 'static) -> Self {
        self.on_resize = Some(Rc::new(f));
        self
    }

    fn base_font(&self) -> Font {
        Font {
            family: self.font_family.clone(),
            features: FontFeatures::disable_ligatures(),
            weight: FontWeight::NORMAL,
            style: FontStyle::Normal,
            fallbacks: None,
        }
    }

    fn register_listeners(&mut self, line_height: Pixels, alt_screen: bool) {
        let focus = self.focus.clone();
        self.interactivity.on_mouse_down(MouseButton::Left, move |_, window, cx| {
            if !focus.is_focused(window) {
                focus.focus(window, cx);
            }
        });

        let state = self.state.clone();
        let on_input = self.on_input.clone();
        self.interactivity.on_scroll_wheel(move |event, window, cx| {
            let delta = f32::from(event.delta.pixel_delta(line_height).y);
            let line_height_f = f32::from(line_height);
            if alt_screen {
                // Full-screen programs get arrow keys instead of history.
                let lines = (delta / line_height_f.max(1.)).round() as i32;
                if lines != 0 {
                    let seq: &[u8] = if lines > 0 { b"\x1b[A" } else { b"\x1b[B" };
                    let bytes = seq.repeat(lines.unsigned_abs().min(20) as usize);
                    if let Some(f) = &on_input {
                        f(bytes, window, cx);
                    }
                }
            } else {
                state.update(cx, |s, _| s.scroll_pixels(delta, line_height_f));
                window.refresh();
            }
            cx.stop_propagation();
        });

        let state = self.state.clone();
        let on_input = self.on_input.clone();
        self.interactivity.on_key_down(move |event, window, cx| {
            let ks = &event.keystroke;
            let mode = state.read(cx).mode();
            let m = &ks.modifiers;
            if m.platform && !m.control && !m.alt && ks.key == "v" {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    let bytes = paste_bytes(&text, mode.contains(TermMode::BRACKETED_PASTE));
                    state.update(cx, |s, _| s.scroll_to_bottom());
                    if let Some(f) = &on_input {
                        f(bytes, window, cx);
                    }
                }
                cx.stop_propagation();
                return;
            }
            if let Some(bytes) = keystroke_to_bytes(ks, mode.contains(TermMode::APP_CURSOR)) {
                state.update(cx, |s, _| s.scroll_to_bottom());
                if let Some(f) = &on_input {
                    f(bytes, window, cx);
                }
                cx.stop_propagation();
            }
        });
    }
}

/// One shaped run of same-style cells on one row.
struct Run {
    row: usize,
    col: usize,
    cells: usize,
    wide: bool,
    text: String,
    style: TextRun,
}

struct BgRect {
    row: usize,
    col: usize,
    cells: usize,
    color: Hsla,
}

struct CursorLayout {
    row: usize,
    col: usize,
    wide: bool,
    shape: CursorShape,
    ch: char,
}

pub struct Layout {
    hitbox: Hitbox,
    origin: Point<Pixels>,
    cell_width: Pixels,
    line_height: Pixels,
    rects: Vec<BgRect>,
    runs: Vec<Run>,
    cursor: Option<CursorLayout>,
    alt_screen: bool,
}

impl Layout {
    fn cell_origin(&self, row: usize, col: usize) -> Point<Pixels> {
        point(self.origin.x + self.cell_width * col as f32, self.origin.y + self.line_height * row as f32)
    }

    fn cell_bounds(&self, row: usize, col: usize, cells: usize) -> Bounds<Pixels> {
        Bounds::new(self.cell_origin(row, col), size(self.cell_width * cells as f32, self.line_height))
    }
}

fn same_style(a: &TextRun, b: &TextRun) -> bool {
    a.font == b.font && a.color == b.color && a.underline == b.underline && a.strikethrough == b.strikethrough
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Layout;

    fn id(&self) -> Option<ElementId> {
        self.interactivity.element_id.clone()
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, global_id: Option<&GlobalElementId>, inspector_id: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let layout_id = self.interactivity.request_layout(global_id, inspector_id, window, cx, |mut style, window, cx| {
            style.size.width = relative(1.).into();
            style.size.height = relative(1.).into();
            window.request_layout(style, None, cx)
        });
        (layout_id, ())
    }

    fn prepaint(&mut self, global_id: Option<&GlobalElementId>, inspector_id: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Layout {
        let base_font = self.base_font();
        let font_size = self.font_size;
        let line_height_factor = self.line_height_factor;
        let padding = self.padding;
        let palette = self.palette.clone();
        let state = self.state.clone();
        let on_resize = self.on_resize.clone();

        self.interactivity.prepaint(global_id, inspector_id, bounds, bounds.size, window, cx, |_, _, hitbox, window, cx| {
            let hitbox = hitbox.unwrap_or_else(|| window.insert_hitbox(bounds, HitboxBehavior::Normal));

            // Cell metrics from the font.
            let text_system = cx.text_system().clone();
            let font_id = text_system.resolve_font(&base_font);
            let cell_width = text_system.advance(font_id, font_size, 'm').map(|s| s.width).unwrap_or(font_size * 0.6);
            let scale = window.scale_factor().max(1.);
            let snap = |v: Pixels| px((f32::from(v) * scale).round() / scale);
            let line_height = snap(font_size * line_height_factor);

            let inner_w = (bounds.size.width - padding * 2.).max(cell_width * 2.);
            let inner_h = (bounds.size.height - padding * 2.).max(line_height);
            let cols = ((f32::from(inner_w) / f32::from(cell_width)).floor() as usize).clamp(2, u16::MAX as usize) as u16;
            let rows = ((f32::from(inner_h) / f32::from(line_height)).floor() as usize).clamp(1, u16::MAX as usize) as u16;
            let origin = point(snap(bounds.origin.x + padding), snap(bounds.origin.y + padding));

            // A collapsed or not-yet-laid-out pane must not shrink the PTY.
            let measurable = bounds.size.width > px(0.) && bounds.size.height > px(0.);
            let changed = measurable && state.update(cx, |s, _| s.resize(cols, rows));
            if changed {
                if let Some(f) = on_resize.clone() {
                    window.defer(cx, move |window, cx| f(cols, rows, window, cx));
                }
            }

            // Walk the visible grid.
            let state = state.read(cx);
            let content = state.renderable_content();
            let colors = content.colors;
            let display_offset = content.display_offset as i32;
            let mode = content.mode;
            let rows_usize = rows as usize;

            let mut rects: Vec<BgRect> = Vec::new();
            let mut runs: Vec<Run> = Vec::new();

            for indexed in content.display_iter {
                let row = indexed.point.line.0 + display_offset;
                if row < 0 || row >= rows_usize as i32 {
                    continue;
                }
                let row = row as usize;
                let col = indexed.point.column.0;
                let cell: &Cell = indexed.cell;
                let flags = cell.flags;
                if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                    continue;
                }
                let wide = flags.contains(Flags::WIDE_CHAR);
                let cells = if wide { 2 } else { 1 };
                let (mut fg, mut bg) = (cell.fg, cell.bg);
                if flags.contains(Flags::INVERSE) {
                    std::mem::swap(&mut fg, &mut bg);
                }

                if !matches!(bg, Color::Named(NamedColor::Background)) {
                    let color = palette.resolve(&bg, colors);
                    match rects.last_mut() {
                        Some(last) if last.row == row && last.col + last.cells == col && last.color == color => last.cells += cells,
                        _ => rects.push(BgRect { row, col, cells, color }),
                    }
                }

                if flags.contains(Flags::HIDDEN) {
                    continue;
                }
                let decorated = flags.intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
                let zero_width = cell.zerowidth();
                if cell.c == ' ' && zero_width.is_none() && !decorated {
                    continue;
                }

                let color = palette.foreground_for(&fg, flags, colors);
                let mut font = base_font.clone();
                if flags.contains(Flags::BOLD) {
                    font.weight = FontWeight::BOLD;
                }
                if flags.contains(Flags::ITALIC) {
                    font.style = FontStyle::Italic;
                }
                let underline = flags.intersects(Flags::ALL_UNDERLINES).then(|| UnderlineStyle {
                    thickness: px(1.),
                    color: Some(color),
                    wavy: flags.contains(Flags::UNDERCURL),
                });
                let strikethrough = flags.contains(Flags::STRIKEOUT).then(|| StrikethroughStyle { thickness: px(1.), color: Some(color) });
                let style = TextRun { len: 0, font, color, background_color: None, underline, strikethrough };

                let mut text = String::new();
                text.push(cell.c);
                if let Some(zw) = zero_width {
                    text.extend(zw);
                }

                match runs.last_mut() {
                    Some(last) if !wide && !last.wide && last.row == row && last.col + last.cells == col && same_style(&last.style, &style) => {
                        last.style.len += text.len();
                        last.text.push_str(&text);
                        last.cells += 1;
                    }
                    _ => {
                        let mut style = style;
                        style.len = text.len();
                        runs.push(Run { row, col, cells, wide, text, style });
                    }
                }
            }

            let cursor = {
                let cur = content.cursor;
                let row = cur.point.line.0 + display_offset;
                if mode.contains(TermMode::SHOW_CURSOR) && !matches!(cur.shape, CursorShape::Hidden) && row >= 0 && (row as usize) < rows_usize {
                    let cell = &state.term().grid()[cur.point];
                    Some(CursorLayout { row: row as usize, col: cur.point.column.0, wide: cell.flags.contains(Flags::WIDE_CHAR), shape: cur.shape, ch: cell.c })
                } else {
                    None
                }
            };

            Layout { hitbox, origin, cell_width, line_height, rects, runs, cursor, alt_screen: mode.contains(TermMode::ALT_SCREEN) }
        })
    }

    fn paint(&mut self, global_id: Option<&GlobalElementId>, inspector_id: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), layout: &mut Layout, window: &mut Window, cx: &mut App) {
        self.register_listeners(layout.line_height, layout.alt_screen);

        let palette = self.palette.clone();
        let focus = self.focus.clone();
        let state = self.state.clone();
        let on_input = self.on_input.clone();
        let font_size = self.font_size;
        let base_font = self.base_font();
        let cursor_bounds = layout.cursor.as_ref().map(|c| layout.cell_bounds(c.row, c.col, if c.wide { 2 } else { 1 }));

        window.paint_quad(fill(bounds, palette.background));

        self.interactivity.paint(global_id, inspector_id, bounds, Some(&layout.hitbox), window, cx, |_, window, cx| {
            window.handle_input(&focus, TermInputHandler { state, on_input, cursor_bounds }, cx);
            window.set_cursor_style(CursorStyle::IBeam, &layout.hitbox);
            let focused = focus.is_focused(window);

            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                for rect in &layout.rects {
                    window.paint_quad(fill(layout.cell_bounds(rect.row, rect.col, rect.cells), rect.color));
                }

                for run in &layout.runs {
                    let force_width = if run.wide { None } else { Some(layout.cell_width) };
                    let line = window.text_system().shape_line(run.text.clone().into(), font_size, std::slice::from_ref(&run.style), force_width);
                    let _ = line.paint(layout.cell_origin(run.row, run.col), layout.line_height, TextAlign::Left, None, window, cx);
                }

                if let (Some(cursor), Some(cursor_bounds)) = (&layout.cursor, cursor_bounds) {
                    let color = palette.cursor;
                    match (cursor.shape, focused) {
                        (CursorShape::Block, true) => {
                            window.paint_quad(fill(cursor_bounds, color));
                            if cursor.ch != ' ' {
                                let style = TextRun { len: cursor.ch.len_utf8(), font: base_font.clone(), color: palette.background, background_color: None, underline: None, strikethrough: None };
                                let line = window.text_system().shape_line(cursor.ch.to_string().into(), font_size, &[style], None);
                                let _ = line.paint(cursor_bounds.origin, layout.line_height, TextAlign::Left, None, window, cx);
                            }
                        }
                        (CursorShape::Block, false) | (CursorShape::HollowBlock, _) => {
                            window.paint_quad(outline(cursor_bounds, color, BorderStyle::default()));
                        }
                        (CursorShape::Underline, _) => {
                            let h = px(2.);
                            let b = Bounds::new(point(cursor_bounds.origin.x, cursor_bounds.origin.y + cursor_bounds.size.height - h), size(cursor_bounds.size.width, h));
                            window.paint_quad(fill(b, color));
                        }
                        (CursorShape::Beam, _) => {
                            let b = Bounds::new(cursor_bounds.origin, size(px(2.), cursor_bounds.size.height));
                            window.paint_quad(fill(b, color));
                        }
                        (CursorShape::Hidden, _) => {}
                    }
                }
            });
        });
    }
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl InteractiveElement for TerminalElement {
    fn interactivity(&mut self) -> &mut Interactivity {
        &mut self.interactivity
    }
}

/// Minimal IME plumbing: no marked text, no selection; composed text is sent
/// straight to the process.
struct TermInputHandler {
    state: Entity<TerminalState>,
    on_input: Option<InputFn>,
    cursor_bounds: Option<Bounds<Pixels>>,
}

impl TermInputHandler {
    fn send(&self, bytes: Vec<u8>, window: &mut Window, cx: &mut App) {
        if bytes.is_empty() {
            return;
        }
        self.state.update(cx, |s, _| s.scroll_to_bottom());
        if let Some(f) = &self.on_input {
            f(bytes, window, cx);
        }
    }
}

impl InputHandler for TermInputHandler {
    fn selected_text_range(&mut self, _ignore_disabled_input: bool, _window: &mut Window, _cx: &mut App) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&mut self, _window: &mut Window, _cx: &mut App) -> Option<Range<usize>> {
        None
    }

    fn text_for_range(&mut self, _range_utf16: Range<usize>, _adjusted_range: &mut Option<Range<usize>>, _window: &mut Window, _cx: &mut App) -> Option<String> {
        None
    }

    fn replace_text_in_range(&mut self, _replacement_range: Option<Range<usize>>, text: &str, window: &mut Window, cx: &mut App) {
        self.send(text.as_bytes().to_vec(), window, cx);
    }

    fn replace_and_mark_text_in_range(&mut self, _range_utf16: Option<Range<usize>>, _new_text: &str, _new_selected_range: Option<Range<usize>>, _window: &mut Window, _cx: &mut App) {}

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut App) {}

    fn paste(&mut self, item: ClipboardItem, window: &mut Window, cx: &mut App) {
        if let Some(text) = item.text() {
            let bracketed = self.state.read(cx).mode().contains(TermMode::BRACKETED_PASTE);
            self.send(paste_bytes(&text, bracketed), window, cx);
        }
    }

    fn bounds_for_range(&mut self, _range_utf16: Range<usize>, _window: &mut Window, _cx: &mut App) -> Option<Bounds<Pixels>> {
        self.cursor_bounds
    }

    fn character_index_for_point(&mut self, _point: Point<Pixels>, _window: &mut Window, _cx: &mut App) -> Option<usize> {
        None
    }

    fn apple_press_and_hold_enabled(&mut self) -> bool {
        false
    }
}
