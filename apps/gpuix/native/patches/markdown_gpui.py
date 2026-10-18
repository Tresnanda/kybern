# Retain a document paragraph's exact full shaping; paint only intersecting
# wrapped glyph ranges. Selection still sees the unsplit canonical TextLayout.
s="crates/gpui/src/elements/text.rs"
edit(s,"    pub fn layout(&self) -> &TextLayout {", "    /// Reuse caller-owned text geometry; the caller invalidates on style changes.\n    pub fn with_layout(mut self, layout: TextLayout) -> Self { self.layout=layout; self }\n\n    pub fn layout(&self) -> &TextLayout {")
s="crates/gpui/src/text_system/line.rs"
# Restrict this to truly large wrapped lines; ordinary text is untouched.
for function, next_function in [("paint_line", "paint_line_background"), ("paint_line_background", None)]:
    text=pending.get(s)
    if text is None: text=subprocess.check_output(['git','-C',str(root),'show',f'HEAD:{s}'],text=True)
    a=text.index("fn "+function+"(")
    b=text.index("    let line_bounds =",a)
    addition="""    if let Some((part, decorations, wraps, origin)) = markdown_visible_line(origin, layout, line_height, decoration_runs, wrap_boundaries, window) {
        return FUNCTION(origin, &part, line_height, align, align_width, &decorations, &wraps, window, cx);
    }
""".replace("FUNCTION",function)
    edit(s,text[a:b],text[a:b]+addition)
helper=(here / "markdown_glyph_slice.rs").read_text()
pending[s] += "\n"+helper

# A Taffy measure callback temporarily owns Window's layout engine. Measuring
# canonical block geometry there therefore needs a separate disposable engine;
# only the resulting sizes escape, never its node ids or frame elements.
s="crates/gpui/src/window.rs"
edit(s,"    pub fn compute_layout(\n", "    /// Measure document blocks using an isolated layout engine. Only sizes may escape.\n    pub fn measure_markdown(&mut self,cx:&mut App,measure:impl FnOnce(&mut Window,&mut App)->Size<Pixels>)->Size<Pixels> {\n        // Cold block measurement must not grow the live frame arena to the whole document.\n        // Only owned text/geometry caches and a size escape this disposable arena.\n        let arena=RefCell::new(Arena::new(1024*1024));\n        let scope=ElementArenaScope::enter(&arena);\n        let parent=self.layout_engine.replace(TaffyLayoutEngine::new());\n        let result=self.with_element_namespace(\"__gpuix_markdown_measure\",|window|measure(window,cx));\n        self.layout_engine=parent;\n        let _clear=scope.exit(&arena);\n        arena.borrow_mut().clear();\n        result\n    }\n\n    pub fn compute_layout(\n")

s="crates/gpui/src/elements/text.rs"
edit(s,"    runs: Option<Vec<TextRun>>,\n    delayed_highlights:","    runs: Option<Vec<TextRun>>,\n    runs_provider: Option<Rc<dyn Fn()->Vec<TextRun>>>,\n    delayed_highlights:")
edit(s,"            runs: None,\n            delayed_highlights:","            runs: None,\n            runs_provider: None,\n            delayed_highlights:")
edit(s,"    pub fn with_runs(mut self, runs: Vec<TextRun>) -> Self {", "    /// Supply immutable document runs only when text geometry needs reshaping.\n    pub fn with_runs_provider(mut self,provider:Rc<dyn Fn()->Vec<TextRun>>)->Self {self.runs_provider=Some(provider);self}\n\n    pub fn with_runs(mut self, runs: Vec<TextRun>) -> Self {")
edit(s,"self.layout.layout(self.text.clone(), runs, window, cx)","self.layout.layout(self.text.clone(), runs, self.runs_provider.take(), window, cx)")
edit(s,"        runs: Option<Vec<TextRun>>,\n        window: &mut Window,\n        _: &mut App,", "        runs: Option<Vec<TextRun>>,\n        runs_provider: Option<Rc<dyn Fn()->Vec<TextRun>>>,\n        window: &mut Window,\n        _: &mut App,")
edit(s,"                let mut line_wrapper = cx.text_system().line_wrapper(text_style.font(), font_size);", "                let provided=runs_provider.as_ref().map(|provider|provider());\n                let runs=provided.as_ref().map_or(runs.as_slice(), |runs| runs.as_slice());\n                let mut line_wrapper = cx.text_system().line_wrapper(text_style.font(), font_size);")

edit(s,"state.layout(SharedString::from(*self), None, window, cx)","state.layout(SharedString::from(*self), None, None, window, cx)")
edit(s,"state.layout(self.clone(), None, window, cx)","state.layout(self.clone(), None, None, window, cx)")
