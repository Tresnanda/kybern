//! VT state: an `alacritty_terminal::Term` driven by a `vte` parser.
//!
//! No PTY lives here. Bytes come in through [`TerminalState::feed`]; anything
//! the emulator wants to send back to the process (device attribute replies,
//! cursor position reports, ...) is queued and drained through
//! [`TerminalState::take_pending_output`].

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, RenderableContent, Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;

/// Number of scrollback lines kept above the visible screen.
pub const SCROLLBACK_LINES: usize = 10_000;

/// Grid size in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

impl TermSize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { cols: cols.max(2), rows: rows.max(1) }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }

    fn screen_lines(&self) -> usize {
        self.rows as usize
    }

    fn columns(&self) -> usize {
        self.cols as usize
    }
}

#[derive(Default)]
struct Shared {
    /// Bytes the emulator wants written to the process.
    pty_writes: Vec<u8>,
    title: Option<String>,
    bell: bool,
}

/// Receives emulator events. Cheap to clone; all clones share one queue.
#[derive(Clone, Default)]
pub struct Listener {
    shared: Arc<Mutex<Shared>>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let mut s = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            Event::PtyWrite(text) => s.pty_writes.extend_from_slice(text.as_bytes()),
            Event::Title(title) => s.title = Some(title),
            Event::ResetTitle => s.title = Some(String::new()),
            Event::Bell => s.bell = true,
            _ => {}
        }
    }
}

/// A terminal screen plus scrollback, without a process behind it.
pub struct TerminalState {
    term: Term<Listener>,
    parser: Processor,
    listener: Listener,
    size: TermSize,
    /// Fractional wheel scroll carried between events.
    scroll_accum: f32,
}

impl TerminalState {
    pub fn new(cols: u16, rows: u16) -> Self {
        let size = TermSize::new(cols, rows);
        let listener = Listener::default();
        let config = Config { scrolling_history: SCROLLBACK_LINES, ..Config::default() };
        let term = Term::new(config, &size, listener.clone());
        Self { term, parser: Processor::new(), listener, size, scroll_accum: 0. }
    }

    /// Feed raw bytes from the process.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// Resize the grid. Returns `true` when the size actually changed.
    pub fn resize(&mut self, cols: u16, rows: u16) -> bool {
        let size = TermSize::new(cols, rows);
        if size == self.size {
            return false;
        }
        self.size = size;
        self.term.resize(size);
        true
    }

    pub fn size(&self) -> TermSize {
        self.size
    }

    pub fn cols(&self) -> u16 {
        self.size.cols
    }

    pub fn rows(&self) -> u16 {
        self.size.rows
    }

    pub fn term(&self) -> &Term<Listener> {
        &self.term
    }

    pub fn term_mut(&mut self) -> &mut Term<Listener> {
        &mut self.term
    }

    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    /// Everything the renderer needs for one frame.
    pub fn renderable_content(&self) -> RenderableContent<'_> {
        self.term.renderable_content()
    }

    /// Scroll the viewport by whole lines; positive is up into history.
    pub fn scroll_lines(&mut self, lines: i32) {
        if lines != 0 {
            self.term.scroll_display(Scroll::Delta(lines));
        }
    }

    /// Scroll by a pixel delta (positive is up into history), accumulating
    /// fractional lines between calls.
    pub fn scroll_pixels(&mut self, delta_px: f32, line_height_px: f32) {
        if line_height_px <= 0. {
            return;
        }
        self.scroll_accum += delta_px / line_height_px;
        let lines = self.scroll_accum.trunc() as i32;
        self.scroll_accum -= lines as f32;
        self.scroll_lines(lines);
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_accum = 0.;
        if self.term.grid().display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
        }
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    pub fn history_size(&self) -> usize {
        self.term.grid().history_size()
    }

    /// Bytes the emulator produced in response to queries, to be written to
    /// the process. Empties the queue.
    pub fn take_pending_output(&mut self) -> Vec<u8> {
        let mut s = self.listener.shared.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut s.pty_writes)
    }

    /// Title set through OSC 0/2, if it changed since the last call. An empty
    /// string means the title was reset.
    pub fn take_title(&mut self) -> Option<String> {
        let mut s = self.listener.shared.lock().unwrap_or_else(|e| e.into_inner());
        s.title.take()
    }

    /// Whether BEL was received since the last call.
    pub fn take_bell(&mut self) -> bool {
        let mut s = self.listener.shared.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut s.bell)
    }

    /// Cursor position on the visible screen as (row, col).
    pub fn cursor(&self) -> (usize, usize) {
        let p: Point = self.term.grid().cursor.point;
        (p.line.0.max(0) as usize, p.column.0)
    }

    /// A cell on the visible screen (row 0 is the top).
    pub fn cell(&self, row: usize, col: usize) -> &Cell {
        &self.term.grid()[Line(row as i32)][Column(col)]
    }

    /// Text of one visible row, trailing spaces trimmed. Wide-char spacers are
    /// skipped so CJK/emoji appear once.
    pub fn row_text(&self, row: usize) -> String {
        let grid = self.term.grid();
        let line = &grid[Line(row as i32)];
        let mut out = String::new();
        for col in 0..grid.columns() {
            let cell = &line[Column(col)];
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            out.push(cell.c);
            if let Some(zw) = cell.zerowidth() {
                out.extend(zw);
            }
        }
        out.truncate(out.trim_end().len());
        out
    }

    /// All visible rows.
    pub fn screen_text(&self) -> Vec<String> {
        (0..self.size.rows as usize).map(|r| self.row_text(r)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

    #[test]
    fn plain_text_and_newlines() {
        let mut t = TerminalState::new(20, 5);
        t.feed(b"hello\r\nworld");
        assert_eq!(t.row_text(0), "hello");
        assert_eq!(t.row_text(1), "world");
        assert_eq!(t.row_text(2), "");
        assert_eq!(t.cursor(), (1, 5));
    }

    #[test]
    fn carriage_return_overwrites() {
        let mut t = TerminalState::new(20, 3);
        t.feed(b"progress 10%\rprogress 99%");
        assert_eq!(t.row_text(0), "progress 99%");
    }

    #[test]
    fn sgr_colors_and_attributes() {
        let mut t = TerminalState::new(40, 3);
        t.feed(b"\x1b[31mred\x1b[0m \x1b[1;4mbu\x1b[0m \x1b[38;5;202mx\x1b[0m \x1b[38;2;1;2;3my\x1b[0m \x1b[7mi\x1b[0m");
        assert_eq!(t.cell(0, 0).fg, Color::Named(NamedColor::Red));
        assert_eq!(t.cell(0, 3).fg, Color::Named(NamedColor::Foreground));
        let bu = t.cell(0, 4);
        assert!(bu.flags.contains(Flags::BOLD));
        assert!(bu.flags.contains(Flags::UNDERLINE));
        assert_eq!(t.cell(0, 7).fg, Color::Indexed(202));
        assert_eq!(t.cell(0, 9).fg, Color::Spec(Rgb { r: 1, g: 2, b: 3 }));
        assert!(t.cell(0, 11).flags.contains(Flags::INVERSE));
    }

    #[test]
    fn resize_keeps_content_and_reports_change() {
        let mut t = TerminalState::new(20, 5);
        t.feed(b"abc\r\ndef");
        assert!(t.resize(30, 8));
        assert!(!t.resize(30, 8));
        assert_eq!(t.size(), TermSize { cols: 30, rows: 8 });
        assert_eq!(t.term().grid().columns(), 30);
        assert_eq!(t.term().grid().screen_lines(), 8);
        assert_eq!(t.row_text(0), "abc");
        assert_eq!(t.row_text(1), "def");
    }

    #[test]
    fn scrollback_and_scrolling() {
        let mut t = TerminalState::new(10, 3);
        for i in 0..10 {
            t.feed(format!("line{i}\r\n").as_bytes());
        }
        // Rows 0..2 show line8, line9, and the empty line after the last newline.
        assert_eq!(t.row_text(0), "line8");
        assert_eq!(t.history_size(), 8);
        assert_eq!(t.display_offset(), 0);
        t.scroll_lines(2);
        assert_eq!(t.display_offset(), 2);
        t.scroll_pixels(15., 10.);
        assert_eq!(t.display_offset(), 3);
        t.scroll_pixels(7., 10.); // 0.5 + 0.7 carried -> one more line
        assert_eq!(t.display_offset(), 4);
        t.scroll_to_bottom();
        assert_eq!(t.display_offset(), 0);
    }

    #[test]
    fn device_attribute_query_produces_reply() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"\x1b[c");
        let reply = t.take_pending_output();
        assert!(reply.starts_with(b"\x1b[?"), "got {reply:?}");
        assert!(t.take_pending_output().is_empty());
    }

    #[test]
    fn title_and_alt_screen_mode() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"\x1b]0;hi there\x07");
        assert_eq!(t.take_title().as_deref(), Some("hi there"));
        assert!(!t.mode().contains(TermMode::ALT_SCREEN));
        t.feed(b"\x1b[?1049h");
        assert!(t.mode().contains(TermMode::ALT_SCREEN));
        t.feed(b"\x1b[?1h");
        assert!(t.mode().contains(TermMode::APP_CURSOR));
    }

    #[test]
    fn wide_chars_render_once() {
        let mut t = TerminalState::new(10, 2);
        t.feed("日本".as_bytes());
        assert_eq!(t.row_text(0), "日本");
        assert!(t.cell(0, 1).flags.contains(Flags::WIDE_CHAR_SPACER));
    }
}
