"""Apply the Kybern cached-island hooks to a GPUIX packages/native/src checkout.

Every edit asserts its anchor exists exactly once, so a GPUIX update that moves
code fails loudly instead of patching the wrong place.
"""
import sys
from pathlib import Path

src = Path(sys.argv[1])


pending: dict[str, str] = {}


def edit(path: str, old: str, new: str, count: int = 1) -> None:
    """Stage one replacement; nothing is written until every anchor matched."""
    s = pending.get(path)
    if s is None:
        s = (src / path).read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} anchor(s), found {found}; nothing written:\n{old}")
    pending[path] = s.replace(old, new)


# lib.rs: register the module.
edit("lib.rs", "mod automation;\n", "mod automation;\nmod cache_island;\n")

# motion.rs: whether a tween is mid-flight.
edit(
    "motion.rs",
    "    pub(crate) fn visible_style(&self, now: Instant) -> Option<MotionStyle> {",
    "    /// Kybern patch: true while the tween has not reached its target.\n"
    "    pub(crate) fn is_active(&self, now: Instant) -> bool {\n"
    "        self.valid && self.sample(now).1\n"
    "    }\n\n"
    "    pub(crate) fn visible_style(&self, now: Instant) -> Option<MotionStyle> {",
)

# automation.rs: re-insert recorded bounds for reused islands.
edit(
    "automation.rs",
    "pub fn get_bounds(id: u64) -> Option<ElementBounds> {",
    "/// Kybern patch: re-record a reused cached island's element bounds.\n"
    "pub fn insert_bounds(id: u64, bounds: ElementBounds) {\n"
    "    BOUNDS.with(|cell| {\n"
    "        cell.borrow_mut().insert(id, bounds);\n"
    "    });\n"
    "}\n\n"
    "pub fn get_bounds(id: u64) -> Option<ElementBounds> {",
)

# renderer.rs ------------------------------------------------------------
r = "renderer.rs"

# Batches notify the root without window.refresh(), which disables every cache.
edit(
    r,
    "    fn request_invalidate(&self) -> Result<()> {\n        #[cfg(target_os = \"macos\")]\n        return invalidate_window();",
    "    fn request_invalidate(&self) -> Result<()> {\n        // Kybern patch: wake changed islands and notify the root, without\n        // window.refresh() (which disables every cache).\n        #[cfg(target_os = \"macos\")]\n        return update_window(|view, _window, cx| {\n            crate::cache_island::notify_changed_islands(view, cx);\n            cx.notify();\n        });",
)

# GpuixView: fields visible to the island module, plus the island registry.
edit(r, "    virtual_lists: HashMap<u64, VirtualListEntry>,\n    /// Latest pointer sample",
     "    pub(crate) virtual_lists: HashMap<u64, VirtualListEntry>,\n    /// Kybern patch: cached islands (`cache_island.rs`).\n    pub(crate) islands: crate::cache_island::Islands,\n    /// Latest pointer sample")
edit(r, "    highlights: HashMap<u64, HighlightCacheEntry>,\n}\n\n/// Two-level cache",
     "    pub(crate) highlights: HashMap<u64, HighlightCacheEntry>,\n}\n\n/// Two-level cache")
edit(r, "            virtual_lists: HashMap::new(),", "            virtual_lists: HashMap::new(),\n            islands: Default::default(),")

# BuildCtx: fields the island module fills, plus the island context.
edit(r, "    virtual_lists: &'a mut HashMap<u64, VirtualListEntry>,\n    pub motion_states",
     "    pub(crate) virtual_lists: &'a mut HashMap<u64, VirtualListEntry>,\n    pub motion_states")
edit(r, "    highlights: &'a mut HashMap<u64, HighlightCacheEntry>,\n    /// `onHighlight` payloads",
     "    pub(crate) highlights: &'a mut HashMap<u64, HighlightCacheEntry>,\n    /// `onHighlight` payloads")
edit(r, "    highlight_events: &'a mut Vec<(u64, usize)>,\n}",
     "    pub(crate) highlight_events: &'a mut Vec<(u64, usize)>,\n"
     "    /// Kybern patch: the island this build renders, if any.\n"
     "    pub(crate) island_root: Option<u64>,\n"
     "    /// Kybern patch: building a `<virtual-list>` row (diagnostic inline override).\n"
     "    pub(crate) in_virtual_row: bool,\n"
     "    pub(crate) islands: &'a mut crate::cache_island::Islands,\n}")

# Both existing BuildCtx constructions build outside any island.
edit(r, "            highlights: &mut self.highlights,\n            highlight_events: &mut highlight_events,\n        };",
     "            highlights: &mut self.highlights,\n            highlight_events: &mut highlight_events,\n            island_root: None,\n            in_virtual_row: true,\n            islands: &mut self.islands,\n        };")
edit(r, "                    highlights: &mut self.highlights,\n                    highlight_events: &mut highlight_events,\n                };",
     "                    highlights: &mut self.highlights,\n                    highlight_events: &mut highlight_events,\n                    island_root: None,\n                    in_virtual_row: false,\n                    islands: &mut self.islands,\n                };")

# Root render: prune islands with the other per-element state.
edit(r, "        self.virtual_lists\n            .retain(|id, _| tree.elements.contains_key(id));\n        // Build the element tree.",
     "        self.virtual_lists\n            .retain(|id, _| tree.elements.contains_key(id));\n        self.islands.prune(&tree);\n        // Build the element tree.")

# build_element: an element with `cache` becomes a cached island.
edit(r, "    let Some(element) = ctx.tree.elements.get(&id) else {\n        return gpui::Empty.into_any_element();\n    };\n\n    let animated_style",
     "    let Some(element) = ctx.tree.elements.get(&id) else {\n        return gpui::Empty.into_any_element();\n    };\n\n"
     "    // Kybern patch: cached islands (`cache_island.rs`).\n"
     "    if crate::cache_island::is_island(element) {\n"
     "        if let Some(island) = crate::cache_island::island_element(id, element, ctx, window, cx) {\n"
     "            return island;\n"
     "        }\n"
     "    }\n\n    let animated_style")

# Types behind the fields the island module fills.
edit(r, "\nstruct HighlightCacheEntry {", "\npub(crate) struct HighlightCacheEntry {")
edit(r, "\nstruct VirtualListEntry {", "\npub(crate) struct VirtualListEntry {")

# Helpers the island module calls.
edit(r, "fn emit_highlight_events(callback: &Option<EventCallback>, events: &[(u64, usize)]) {",
     "pub(crate) fn emit_highlight_events(callback: &Option<EventCallback>, events: &[(u64, usize)]) {")

# Native titlebar: register module and attach gestures before host event wiring.
edit("lib.rs", "mod cache_island;\n", "mod cache_island;\nmod window_drag;\n")
edit(r, "    // Wire up events.\n", "    if element.custom_props.get(\"windowDrag\").and_then(|v| v.as_bool()) == Some(true) {\n        el = crate::window_drag::apply(el);\n    }\n\n    // Wire up events.\n")

# Key interception and close decisions: optional event token and native replies.
edit("lib.rs", "mod window_drag;\n", "mod window_drag;\nmod key_intercept;\nmod close_guard;\n")
edit("element_tree.rs", "    pub is_held: Option<bool>,", "    pub is_held: Option<bool>,\n    pub request_id: Option<u32>,")
edit("element_tree.rs", "            is_held: None,", "            is_held: None,\n            request_id: None,")
edit(r, "            with_window_menu_actions(root)\n", "            with_window_menu_actions(root)\n                .child(crate::key_intercept::listener(callback.clone()))\n")
edit(r, ".on_action(|_: &CloseWindow, window, _cx| window.remove_window())", ".on_action(|_: &CloseWindow, window, _cx| crate::close_guard::request(window))")
# Insert into the native napi impl, alongside the other window APIs.
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn resolve_key_event(&self, token: u32, prevented: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, cx| crate::key_intercept::resolve(token, prevented, window, cx));
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Key interception is currently macOS-only"))
    }

    #[napi]
    pub fn set_close_guard(&self, enabled: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window(|view, window, cx| crate::close_guard::install(if enabled { view.event_callback.clone() } else { None }, window, cx));
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Close guards are currently macOS-only"))
    }

    #[napi]
    pub fn resolve_close_request(&self, token: u32, allow: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, _cx| crate::close_guard::resolve(token, allow, window));
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Close guards are currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")
# The text editor owns its subscription and removes it when unmounted.
i = "custom_elements/input.rs"
edit(i, "    state: Option<Entity<TextEditorState>>,", "    state: Option<Entity<TextEditorState>>,\n    intercept_keys: Vec<String>,\n    key_interceptor: Option<gpui::Subscription>,")
edit(i, "            state: None,", "            state: None,\n            intercept_keys: Vec::new(),\n            key_interceptor: None,")
edit(i, "    emits_key_down: bool,", "    emits_key_down: bool,\n    intercept_keys: Vec<String>,")
edit(i, "                let cursor = value.len();", "                let cursor = value.len();\n                let intercept_keys = self.intercept_keys.clone();")
edit(i, "                    emits_key_down,", "                    emits_key_down,\n                    intercept_keys,")
edit(i, "        let prop_changed = self.last_prop_value.as_ref() != Some(&self.value);", """        #[cfg(target_os = "macos")]
        if self.key_interceptor.is_none() {
            let weak = state.downgrade();
            self.key_interceptor = Some(cx.intercept_keystrokes(move |event, window, cx| {
                if crate::key_intercept::replaying() { return; }
                let Some(state) = weak.upgrade() else { return; };
                let state = state.read(cx);
                if state.emits_key_down && state.marked_range.is_none()
                    && state.focus_handle.is_focused(window)
                    && (state.intercept_keys.contains(&event.keystroke.key) || crate::key_intercept::pending())
                {
                    crate::key_intercept::capture(state.element_id, state.focus_handle.clone(), state.intercept_keys.contains(&event.keystroke.key), window, cx);
                }
            }));
        }
        let prop_changed = self.last_prop_value.as_ref() != Some(&self.value);""")
edit(i, "            state.emits_key_down = emits_key_down;", "            state.emits_key_down = emits_key_down;\n            state.intercept_keys = self.intercept_keys.clone();")
edit(i, '            "readOnly" => self.read_only = value.as_bool().unwrap_or(false),', '            "interceptKeys" => self.intercept_keys = value.as_array().map(|keys| keys.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect()).unwrap_or_default(),\n            "readOnly" => self.read_only = value.as_bool().unwrap_or(false),')
edit(i, '            "maxRows",\n            "theme",', '            "maxRows",\n            "interceptKeys",\n            "theme",')
edit(i, "        self.state = None;", "        self.state = None;\n        self.key_interceptor = None;")
edit(i, '                editor.on_key_down(move |event, _window, _cx| {', '                editor.on_key_down(move |event, _window, _cx| {\n                    if crate::key_intercept::replaying() { return; }')

# Secure single-line inputs: mask only presentation, retaining the native edit buffer.
edit("lib.rs", "mod close_guard;\n", "mod close_guard;\nmod secure_input;\n")
edit(i, "    key_interceptor: Option<gpui::Subscription>,", "    key_interceptor: Option<gpui::Subscription>,\n    secure: bool,")
edit(i, "            key_interceptor: None,", "            key_interceptor: None,\n            secure: false,")
edit(i, "    emits_key_up: bool,", "    emits_key_up: bool,\n    secure: bool,\n    secure_session: crate::secure_input::Session,\n    secure_subscriptions: Vec<gpui::Subscription>,")
edit(i, "                    emits_key_up,", "                    emits_key_up,\n                    secure: false,\n                    secure_session: Default::default(),\n                    secure_subscriptions: Vec::new(),")
edit(i, '            "interceptKeys" =>', '            "secure" => self.secure = !self.multiline && value.as_bool().unwrap_or(false),\n            "interceptKeys" =>')
edit(i, '            "interceptKeys",\n', '            "interceptKeys",\n            "secure",\n')
edit(i, "            state.emits_key_up = emits_key_up;", """            state.emits_key_up = emits_key_up;
            state.secure = self.secure;
            if state.secure && state.secure_subscriptions.is_empty() {
                let focus = state.focus_handle.clone();
                state.secure_subscriptions = vec![
                    cx.on_focus(&focus, _window, |state, window, _| state.update_secure_input(window)),
                    cx.on_blur(&focus, _window, |state, window, _| state.update_secure_input(window)),
                    cx.observe_window_activation(_window, |state, window, _| state.update_secure_input(window)),
                ];
            }
            state.update_secure_input(_window);""")
edit(i, "impl TextEditorState {", """impl TextEditorState {
    fn update_secure_input(&mut self, window: &Window) {
        self.secure_session.set(self.secure && self.focus_handle.is_focused(window) && window.is_window_active());
    }
    fn display_content(&self) -> String {
        if self.secure { crate::secure_input::mask(&self.content) } else { self.content.clone() }
    }
""")
edit(i, '        let default_role = if self.multiline {', '        let default_role = if self.secure {\n            gpui::Role::PasswordInput\n        } else if self.multiline {')
edit(i, '        if ctx.props.get("aria-valuetext").is_none() && !self.value.is_empty() {', '        if self.secure {\n            editor = editor.role(gpui::Role::PasswordInput).aria_value(crate::secure_input::mask(&self.value));\n        } else if ctx.props.get("aria-valuetext").is_none() && !self.value.is_empty() {')
edit(i, "    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {", "    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {\n        if self.secure { return; }")
edit(i, "    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {", "    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {\n        if self.secure { return; }")
edit(i, "(SharedString::from(self.content.clone()), false)", "(SharedString::from(self.display_content()), false)")
edit(i, "                        input.content.clone().into()", "                        input.display_content().into()")
edit(i, "    fn point_for_index(&self, index: usize) -> Option<Point<Pixels>> {", "    fn point_for_index(&self, index: usize) -> Option<Point<Pixels>> {\n        let index = if self.secure { crate::secure_input::display_index(&self.content, index) } else { index };")
edit(i, "                return (line_start + index).min(self.content.len());", "                return if self.secure { crate::secure_input::content_index(&self.content, line_start + index) } else { (line_start + index).min(self.content.len()) };")
edit(i, "        let runs = match self.marked_range.as_ref() {", """        let display_marked = self.marked_range.as_ref().map(|range| {
            if self.secure {
                crate::secure_input::display_index(&self.content, range.start)..crate::secure_input::display_index(&self.content, range.end)
            } else { range.clone() }
        });
        let runs = match display_marked.as_ref() {""")
# Retained-tree inspection is used by automation. Never serialize a secure value.
edit("retained_tree.rs", '            obj.insert("customProps".to_string(), serde_json::Value::Object(custom));', """            let mut custom = custom;
            if element.element_type == "input" && element.custom_props.get("secure").and_then(|v| v.as_bool()) == Some(true) {
                custom.remove("value");
                custom.remove("aria-valuetext");
            }
            obj.insert("customProps".to_string(), serde_json::Value::Object(custom));""")

# Preserve syntax TextRuns and native selection while wrapping lines.
edit("lib.rs", "mod secure_input;\n", "mod secure_input;\nmod code_wrap;\n")
c = "custom_elements/code.rs"
edit(c, "    show_line_numbers: bool,", "    show_line_numbers: bool,\n    soft_wrap: bool,")
edit(c, "        for (line_ix, line) in lines.iter().enumerate() {", "        content = crate::code_wrap::content(content, self.soft_wrap);\n        for (line_ix, line) in lines.iter().enumerate() {")
edit(c, "            if self.show_line_numbers {", "            row = crate::code_wrap::row(row, self.soft_wrap, type_style.line_height);\n            if self.show_line_numbers {")
edit(c, "            content = content.child(row.child(ctx.text(line_ix, line.to_string(), Some(runs))));", """            let text = ctx.text(line_ix, line.to_string(), Some(runs));
            content = content.child(row.child(if self.soft_wrap {
                gpui::div().flex_1().min_w_0().child(text).into_any_element()
            } else { text.into_any_element() }));""")
edit(c, "            .overflow_x_scroll()\n            .restrict_scroll_to_axis()", "            .when(!self.soft_wrap, |body| body.overflow_x_scroll().restrict_scroll_to_axis())")
edit(c, '            "showLineNumbers" => self.show_line_numbers = value.as_bool().unwrap_or(false),', '            "softWrap" => self.soft_wrap = value.as_bool().unwrap_or(false),\n            "showLineNumbers" => self.show_line_numbers = value.as_bool().unwrap_or(false),')
edit(c, '&["code", "language", "path", "showLineNumbers", "theme"]', '&["code", "language", "path", "showLineNumbers", "softWrap", "theme"]')

# Native spring easing and layout-neutral translation.
edit("lib.rs", "mod code_wrap;\n", "mod code_wrap;\nmod spring;\nmod translate;\n")
m = "motion.rs"
edit(m, "    pub border_radius: Option<f64>,", "    pub border_radius: Option<f64>,\n    pub translate_x: Option<f64>,\n    pub translate_y: Option<f64>,")
edit(m, "            border_radius: self.border_radius.or(fallback.border_radius),", "            border_radius: self.border_radius.or(fallback.border_radius),\n            translate_x: self.translate_x.or(fallback.translate_x),\n            translate_y: self.translate_y.or(fallback.translate_y),")
edit(m, "            border_radius: value(self.border_radius, target.border_radius, progress),", "            border_radius: value(self.border_radius, target.border_radius, progress),\n            translate_x: value(self.translate_x, target.translate_x, progress),\n            translate_y: value(self.translate_y, target.translate_y, progress),")
edit(m, "struct MotionTransition {", "struct MotionTransition {\n    #[serde(default, rename = \"type\")]\n    kind: Option<String>,\n    #[serde(default)]\n    bounce: f64,")
edit(m, "            duration: default_duration(),", "            kind: None,\n            bounce: 0.0,\n            duration: default_duration(),")
edit(m, "        let progress = ease(raw.clamp(0.0, 1.0), &self.transition.ease);", """        let progress = if self.transition.kind.as_deref() == Some("spring") {
            crate::spring::progress(raw.clamp(0.0, 1.0), self.transition.bounce)
        } else { ease(raw.clamp(0.0, 1.0), &self.transition.ease) };""")
edit(m, "    validate_ease(&description.transition.ease)?;", """    validate_ease(&description.transition.ease)?;
    if !matches!(description.transition.kind.as_deref(), None | Some("tween" | "spring")) {
        return Err("motion transition type must be tween or spring".into());
    }
    if !description.transition.bounce.is_finite() || !(0.0..=1.0).contains(&description.transition.bounce) {
        return Err("motion spring bounce must be between 0 and 1".into());
    }""")
edit(m, '        ("borderRadius", style.border_radius),', '        ("borderRadius", style.border_radius),\n        ("translateX", style.translate_x),\n        ("translateY", style.translate_y),')
# Spring overshoot is meaningful for geometry, but opacity and sizes must stay legal.
edit(m, "style.opacity = Some(value);", "style.opacity = Some(value.clamp(0.0, 1.0));")
edit(m, "style.width = Some(DimensionValue::Pixels(value));", "style.width = Some(DimensionValue::Pixels(value.max(0.0)));")
edit(m, "style.height = Some(DimensionValue::Pixels(value));", "style.height = Some(DimensionValue::Pixels(value.max(0.0)));")
edit(m, "style.border_radius = Some(value);", "style.border_radius = Some(value.max(0.0));")
edit(r, "    ctx.inherited = parent_inherited;\n    built", """    ctx.inherited = parent_inherited;
    let translated = ctx.motion_states.get(&id).and_then(|state| state.visible_style(ctx.now));
    if let Some(motion) = translated {
        crate::translate::apply(built, motion.translate_x.unwrap_or(0.0), motion.translate_y.unwrap_or(0.0))
    } else { built }""")

# Explicit startup font registration through GPUI's platform text system.
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn register_font(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        let bytes = data.to_vec();
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, cx| {
            cx.text_system().add_fonts(vec![std::borrow::Cow::Owned(bytes)])
                .map_err(|error| Error::from_reason(error.to_string()))?;
            window.refresh();
            Ok(())
        })?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Font registration is currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")

# A list row must establish the available width before percentage-sized islands
# are measured: cached views intentionally have no intrinsic content width.
edit(r, "        let Some(focus_handle) = row_focus_handle else {\n            return child;\n        };", "        let Some(focus_handle) = row_focus_handle else {\n            return gpui::div().w_full().child(child).into_any_element();\n        };")

# Selection and atomic editor transactions use the mounted native edit model.
edit(i, "impl TextEditorState {", 'include!("../input_api.rs");\n\nimpl TextEditorState {')
edit(i, "        let prop_changed = self.last_prop_value.as_ref() != Some(&self.value);", "        remember_editor(ctx.id, &state);\n        let prop_changed = self.last_prop_value.as_ref() != Some(&self.value);")
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn get_input_selection(&self, element_id: f64) -> Result<serde_json::Value> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |_, cx| crate::custom_elements::input::input_selection(id, cx))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Input selection is currently macOS-only"))
    }

    #[napi]
    pub fn set_input_selection(&self, element_id: f64, start: f64, end: f64, reversed: bool) -> Result<()> {
        let id = to_element_id(element_id)?;
        let start = crate::custom_elements::input::utf16_offset(start)?;
        let end = crate::custom_elements::input::utf16_offset(end)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |_, cx| crate::custom_elements::input::select_input(id, start, end, reversed, cx))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Input selection is currently macOS-only"))
    }

    #[napi]
    pub fn edit_input(&self, element_id: f64, edit: serde_json::Value) -> Result<()> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, cx| crate::custom_elements::input::edit_input(id, edit, window, cx))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Input transactions are currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")

# Cached paint must restore selection geometry and text inspection, too.
edit("text/paint.rs", "struct RegEntry {", "#[derive(Clone)]\nstruct RegEntry {")
edit("text/paint.rs", "struct StartRegion {", "#[derive(Clone)]\nstruct StartRegion {")
edit("text/paint.rs", "pub type SharedSelection = Arc<Mutex<SelectionState>>;", 'pub type SharedSelection = Arc<Mutex<SelectionState>>;\ninclude!("../selection_cache.rs");')

edit("text/selection.rs", "    pub fn clear(&mut self) {", """    pub(crate) fn ranges(&self) -> serde_json::Value {
        serde_json::Value::Array(self.spans.iter().filter(|span| !span.range.is_empty()).map(|span| {
            let (id, sub) = span.key.split_once(':').unwrap_or(("0", "0"));
            serde_json::json!({"elementId": id.parse::<u64>().unwrap_or(0), "sub": sub.parse::<u32>().unwrap_or(0),
                "start": span.text[..span.range.start].encode_utf16().count(),
                "end": span.text[..span.range.end].encode_utf16().count(), "text": span.text})
        }).collect())
    }

    pub fn clear(&mut self) {""")
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn get_text_selection(&self) -> serde_json::Value {
        self.selection.lock().ranges()
    }

    #[napi]
    pub fn set_text_selection(&self, element_id: f64, sub: f64, start: f64, end: f64) -> Result<()> {
        let id = to_element_id(element_id)?;
        let selection = self.selection.clone();
        let tree = self.tree.clone();
        let sub = crate::custom_elements::input::utf16_offset(sub)?;
        let start = crate::custom_elements::input::utf16_offset(start)?;
        let end = crate::custom_elements::input::utf16_offset(end)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, _cx| {
            crate::text::paint::select_text(&selection, &tree.lock().unwrap(), id, sub, start, end)?;
            window.refresh();
            Ok(())
        })?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Text selection is currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")

for path, text in pending.items():
    (src / path).write_text(text)
print(f"hooks applied to {len(pending)} files")
