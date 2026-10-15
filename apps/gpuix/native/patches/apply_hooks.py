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
     "    /// Kybern patch: building a `<virtual-list>` row (islands render inline).\n"
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

for path, text in pending.items():
    (src / path).write_text(text)
print(f"hooks applied to {len(pending)} files")
