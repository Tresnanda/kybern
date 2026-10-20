r = src / "renderer.rs"
source = r.read_text()
anchor = "let mut el = gpui::div().id(gpui::ElementId::Integer(element.id));"
if source.count(anchor) != 1:
    raise SystemExit("hover owner: host builder anchor moved")
source = source.replace(anchor, anchor[:-1] + ".hover_owner(cx.entity_id(), element.id);")
anchor = "el = el.on_hover(move |&is_hovered, _window, _cx| {"
if source.count(anchor) != 1:
    raise SystemExit("hover owner: event bridge anchor moved")
source = source.replace(anchor, "el = el.on_hover(move |&is_hovered, window, _cx| {\n                        let (x, y) = point_to_xy(window.mouse_position());")
for value in ["true", "false"]:
    anchor = f"p.hovered = Some({value});"
    if source.count(anchor) != 1:
        raise SystemExit("hover owner: hover payload anchor moved")
    source = source.replace(anchor, anchor + "\n                                p.x = Some(x);\n                                p.y = Some(y);")
pending["renderer.rs"] = source
r.write_text(source)
