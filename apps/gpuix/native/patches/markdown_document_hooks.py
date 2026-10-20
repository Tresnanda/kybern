# Additive P3 document/viewport capability, after all Markdown style hooks.
edit("lib.rs", "mod markdown_style;", "mod markdown_style;\nmod markdown_document;\nmod markdown_model;\nmod markdown_view;")
r = "renderer.rs"
edit(r, "    syntax_documents: crate::syntax_document::Shared,", "    syntax_documents: crate::syntax_document::Shared,\n    markdown_documents: crate::markdown_document::Shared,")
edit(r, "            syntax_documents: Default::default(),", "            syntax_documents: Default::default(),\n            markdown_documents: Default::default(),")
edit(r, "        crate::syntax_document::activate(&self.syntax_documents);", "        crate::syntax_document::activate(&self.syntax_documents);\n        crate::markdown_document::activate(&self.markdown_documents);")
edit(r, "        self.syntax_documents.lock().unwrap().close();", "        self.syntax_documents.lock().unwrap().close();\n        self.markdown_documents.lock().unwrap().close();")
edit(r, "    pub fn zoom_window(&self) -> Result<()> {", """    pub fn create_markdown_document(&self, options: serde_json::Value) -> Result<napi::bindgen_prelude::AsyncTask<crate::markdown_document::ParseTask>> {
        let registry = update_window(|view, _, _| view.markdown_documents.clone())?;
        Ok(napi::bindgen_prelude::AsyncTask::new(crate::markdown_document::Registry::prepare(registry, None, options)?))
    }
    #[napi]
    pub fn update_markdown_document(&self, id: String, options: serde_json::Value) -> Result<napi::bindgen_prelude::AsyncTask<crate::markdown_document::ParseTask>> {
        let registry = update_window(|view, _, _| view.markdown_documents.clone())?;
        Ok(napi::bindgen_prelude::AsyncTask::new(crate::markdown_document::Registry::prepare(registry, Some(id), options)?))
    }
    #[napi]
    pub fn release_markdown_document(&self, id: String) -> Result<()> {
        update_window(move |view, _, _| view.markdown_documents.lock().unwrap().release(&id))
    }
    #[napi]
    pub fn get_markdown_document_text(&self, id: String, revision: u32) -> Result<String> {
        update_window(move |view, _, _| view.markdown_documents.lock().unwrap().source(&id, revision))?
    }
    #[napi]
    pub fn get_markdown_document_layout(&self, id: String, revision: u32) -> Result<serde_json::Value> {
        update_window(move |view, _, _| view.markdown_documents.lock().unwrap().layout(&id, revision))?
    }
    #[napi]
    pub fn get_markdown_document_stats(&self) -> Result<serde_json::Value> {
        update_window(|view, _, _| view.markdown_documents.lock().unwrap().stats())
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {""")
# The event stream is parsed once with its complete reference-definition map.
p = "markdown/parser.rs"
edit(p, "pub fn parse(source: &str) -> BlockTree {", "pub fn parse(source: &str) -> BlockTree { parse_document(source).0 }\n\npub fn parse_document(source: &str) -> (BlockTree, Vec<Range<usize>>) { let (tree,ranges,_)=parse_document_defs(source);(tree,ranges) }\n\n#[derive(Clone, Debug)]\npub struct ReferenceDefinition {pub label:String,pub url:String,pub title:Option<String>,pub range:Range<usize>}\n\npub fn parse_document_defs(source: &str) -> (BlockTree, Vec<Range<usize>>, Vec<ReferenceDefinition>) {")
edit(p, "    let mut blocks = Vec::new();\n    while let Some((event, _)) = cur.peek() {", "    let mut blocks = Vec::new();\n    let mut ranges = Vec::new();\n    while let Some((event, range)) = cur.peek() {\n        let start = range.start;\n        let before = blocks.len();")
edit(p, "    BlockTree { blocks }\n}", "        let _ = ();\n    (BlockTree { blocks }, ranges)\n}")
# Inject after the top-level match, not the recursive parser's loops.
edit(p, "            _ => cur.bump(),\n        }\n    }\n        let _ = ();", "            _ => cur.bump(),\n        }\n        let end = events.get(cur.ix.saturating_sub(1)).map_or(start, |(_, range)| range.end);\n        ranges.extend((before..blocks.len()).map(|_| start..end));\n    }")
p = "custom_elements/markdown.rs"
edit(p, "    parsed_hash: Option<u64>,", "    parsed_hash: Option<u64>,\n    document: Option<String>,\n    revision: u32,\n    start_block: usize,\n    end_block: Option<usize>,\n    document_lease: Option<Arc<crate::markdown_document::Document>>,\n    viewport: crate::markdown_view::Cache,")
edit(p, "        let tree = self.tree();", """        if let Some(id) = &self.document {
            if self.document_lease.as_ref().map(|d| d.revision) != Some(self.revision) {
                self.document_lease = crate::markdown_document::lookup(id, self.revision);
                if let Some(doc)=&self.document_lease {crate::markdown::render::invalidate_document(&self.viewport,doc,self.start_block,self.end_block);}else{self.viewport.borrow_mut().clear();}
            }
        } else { self.document_lease = None; }
        let document = self.document_lease.clone();
        let tree = if document.is_none() { Some(self.tree()) } else { None };""")
edit(p, "        let body = render_tree(&tree, &mut md, window);", """        let body = if let Some(document) = document {
            md.viewport = Some(self.viewport.clone());
            crate::markdown::render::render_document(document, &mut md, window,self.start_block,self.end_block)
        } else { render_tree(tree.as_ref().unwrap(), &mut md, window) };""")
edit(p, '            "theme" => self.theme = Theme::from_prop(Some(&value)),', '            "document" => { self.document = value.as_str().map(str::to_owned); self.document_lease = None; },\n            "startBlock" => {self.start_block=value.as_u64().unwrap_or(0) as usize;self.viewport.borrow_mut().clear();},\n            "endBlock" => {self.end_block=value.as_u64().map(|n|n as usize);self.viewport.borrow_mut().clear();},\n            "revision" => self.revision = value.as_u64().unwrap_or(0) as u32,\n            "theme" => { self.theme = Theme::from_prop(Some(&value)); self.viewport.borrow_mut().clear(); },')
edit(p, '&["source", "theme"]', '&["source", "theme", "document", "revision", "startBlock", "endBlock"]')
edit(p, "        self.tree = None;", "        self.tree = None;\n        self.document_lease = None;\n        self.viewport.borrow_mut().clear();")
r = "markdown/render.rs"
edit(r, "pub struct MdContext {", "#[derive(Clone)]\npub struct MdContext {")
edit(r, "    next_sub: usize,", "    next_sub: usize,\n    pub viewport: Option<crate::markdown_view::Cache>,\n    pub document_node: Option<DocumentNode>,")
edit(r, "            next_sub: 0,", "            next_sub: 0,\n            viewport: None,\n            document_node: None,")
edit(r, 'include!("../markdown_stream.rs");', 'include!("../markdown_stream.rs");\ninclude!("../markdown_document_render.rs");')

edit(r, "    let m = &theme.metrics;\n    match block {", "    let m = &theme.metrics;\n    if ctx.viewport.is_some() { if let Some(element)=document_container(block,ctx,window) { return element; } }\n    match block {")

# Reuse exact paragraph shaping without reconstructing an entire StyledText layout.
edit("text/paint.rs", "    pub extra_wash: Option<Box<dyn Fn(&TextLayout, &mut Window)>>,", "    pub retained_layout: Option<TextLayout>,\n    pub extra_wash: Option<Box<dyn Fn(&TextLayout, &mut Window)>>,")
edit("text/paint.rs", "            extra_wash: None,", "            retained_layout: None,\n            extra_wash: None,")
edit("text/paint.rs", "        extra_wash,\n        links,", "        extra_wash,\n        retained_layout,\n        links,")
edit("text/paint.rs", "    let layout = styled.layout().clone();", "    let styled=if let Some(layout)=retained_layout {styled.with_layout(layout)}else{styled};\n    let layout = styled.layout().clone();")
# The cache belongs to the document body, never to the process or frame arena.
edit(r, "fn flat_text_element(flat: &FlatText, size: f32, ctx: &mut MdContext) -> AnyElement {\n    let sub = ctx.take_sub();", "fn flat_text_element(flat: &FlatText, size: f32, ctx: &mut MdContext) -> AnyElement {\n    let sub = ctx.take_sub();\n    let retained_layout=ctx.viewport.as_ref().map(|cache|crate::markdown_view::cached(cache,sub,||gpui::TextLayout::default()).as_ref().clone());")
edit(r, "        extra_wash: extra,", "        retained_layout,\n        extra_wash: extra,")

edit(r, "pub struct FlatText {", "#[derive(Clone)]\npub struct FlatText {")
edit(r, "    let mut flat = flatten_runs(runs, &ctx.theme, weight);", "    let mut flat = if let Some(cache)=&ctx.viewport { crate::markdown_view::cached(cache,ctx.next_sub,||flatten_runs(runs,&ctx.theme,weight)).as_ref().clone() } else { flatten_runs(runs, &ctx.theme, weight) };")
p="markdown_inline.rs"
edit(p,"struct InlineFlow {\n    data: Rc<InlineData>,\n}","struct InlineFlow {\n    data: Rc<InlineData>,\n    layout: Rc<RefCell<Option<InlineLayout>>>,\n}")
edit(p,"        let state = Rc::new(RefCell::new(None));","        let state = self.layout.clone();")
edit(p,"            let layout = data.layout(width, window);\n            let height = layout.height;\n            *output.borrow_mut() = Some(layout);", "            let mut cache=output.borrow_mut();\n            if cache.as_ref().is_none_or(|layout|layout.width!=width) { *cache=Some(data.layout(width,window)); }\n            let height=cache.as_ref().unwrap().height;")
# Cache tokenization, flattening inputs and exact wrap positions; never cache
# AnyElement, a Taffy id or an element arena reference across frames.
text=pending.get(p,(src/p).read_text())
a=text.index("    let mut tokens = Vec::new();",text.index("fn inline_element("))
b=text.index("    let base = ctx.next_sub;",a)
tokens=text[a:b]
c=text.index("    InlineFlow {",b)
d=text.index("            flat: FlatText {",c)
end=text.index("        }),\n    }\n    .into_any_element()",d)
fields=text[d:end]
replacement="""    let base=ctx.next_sub;
    ctx.next_sub+=flat.text.len()+2;
    let viewport=ctx.viewport.clone();
    let create=|| {
TOKENS
        InlineData {
FIELDS
        }
    };
    let data=if let Some(cache)=&viewport {crate::markdown_view::cached(cache,base,create)}else{Rc::new(create())};
    let layout=if let Some(cache)=&viewport {crate::markdown_view::cached(cache,base,||RefCell::new(None))}else{Rc::new(RefCell::new(None))};
    InlineFlow {data,layout}.into_any_element()
""".replace("TOKENS",tokens).replace("FIELDS",fields)
edit(p,text[a:text.index("\n}",end)],replacement.rstrip())

edit("text/selection.rs", "    pub fn is_dragging(&self) -> bool {", "    pub(crate) fn document_anchor(&self) -> Option<&str> {self.is_dragging().then_some(self.anchor_key.as_str())}\n\n    pub fn is_dragging(&self) -> bool {")
edit("text/paint.rs", "        let elements: Vec<selection::RegisteredText> = reg", "        if let Some(result)=crate::markdown_view::resolve_drag(selection,reg[head.0].key.as_ref(),head.1) {return result;}\n        let elements: Vec<selection::RegisteredText> = reg")
edit(r,"    let sub = ctx.take_sub();\n    let retained_layout=", "    let sub = ctx.take_sub();\n    document_record(ctx,sub,flat.text.clone(),None);\n    let retained_layout=")
# Inline tokens remain one logical paragraph for copy, including hard breaks.
edit("markdown_inline.rs","        InlineData {\n            flat: FlatText {", "        for token in &tokens { if let Some(cache)=&ctx.viewport {crate::markdown_view::record(cache,ctx.element_id,base+1+token.range.start,flat.text.clone(),token.range.clone(),Some(ctx.element_id.rotate_left(32)^base as u64));} }\n        InlineData {\n            flat: FlatText {")

edit("markdown/parser.rs", "    let events: Vec<(Event, Range<usize>)> = Parser::new_ext(source, options())\n        .into_offset_iter()", "    let parser=Parser::new_ext(source,options());\n    let definitions=parser.reference_definitions().iter().map(|(label,def)|ReferenceDefinition{label:label.to_string(),url:def.dest.to_string(),title:def.title.as_ref().map(ToString::to_string),range:def.span.clone()}).collect();\n    let events: Vec<(Event, Range<usize>)> = parser\n        .into_offset_iter()")
edit("markdown/parser.rs", "    (BlockTree { blocks }, ranges)\n}", "    (BlockTree { blocks }, ranges, definitions)\n}")

# A giant mixed-size paragraph has many tokens but only a few visible lines.
# Baseline alignment can shift tokens within a line; include one extra line.
edit("markdown_inline.rs", "        for position in &layout.positions {", "        let top=f32::from(clip.top()-bounds.top())-data.line;\n        let bottom=f32::from(clip.bottom()-bounds.top())+data.line;\n        let start=layout.positions.partition_point(|p|p.y+p.height<top);\n        let end=layout.positions.partition_point(|p|p.y<=bottom);\n        for position in &layout.positions[start..end] {")

# Interaction/search state changes independently of immutable shaped content.
# Keep it on the frame's InlineFlow, never in the retained input cache.
p="markdown_inline.rs"
text=pending.get(p,(src/p).read_text())
a=text.index("    selection: SharedSelection,")
b=text.index("    icons:",a)
fields=text[a:b]
caret="    caret: Option<Hsla>,\n"
edit(p,fields,"")
edit(p,caret,"",1)
interaction="struct InlineInteraction {\n"+fields+caret+"}\n"
edit(p,"struct InlineFlow {",interaction+"struct InlineFlow {")
edit(p,"    layout: Rc<RefCell<Option<InlineLayout>>>,","    layout: Rc<RefCell<Option<InlineLayout>>>,\n    interaction: InlineInteraction,")
text=pending[p]
a=text.index("            selection: ctx.selection.clone(),",text.index("fn inline_element("))
b=text.index("            icons:",a)
init=text[a:b]
caret_init="            caret: ctx.caret.take(),\n"
edit(p,init,"")
edit(p,caret_init,"",1)
edit(p,"    let viewport=ctx.viewport.clone();", "    let viewport=ctx.viewport.clone();\n    let interaction=InlineInteraction {\n"+init+caret_init+"    }; ")
edit(p,"    InlineFlow {data,layout}.into_any_element()","    InlineFlow {data,layout,interaction}.into_any_element()")
edit(p,"        let data = &self.data;","        let data = &self.data;\n        let interaction = &self.interaction;")
for field in ["selectable","selection_wash","selection","hover_link_color","on_link","highlight","caret"]:
    text=pending[p]
    old="data."+field
    if old in text: pending[p]=text.replace(old,"interaction."+field)

# Keep giant styled paragraphs O(visible runs), including materialization of
# StyledText's inputs. The provider is evaluated only when width needs reshaping.
edit("text/paint.rs","    pub retained_layout: Option<TextLayout>,","    pub retained_layout: Option<TextLayout>,\n    pub run_provider: Option<std::rc::Rc<dyn Fn()->Vec<TextRun>>>,")
edit("text/paint.rs","            retained_layout: None,","            retained_layout: None,\n            run_provider: None,")
edit("text/paint.rs","        retained_layout,\n        links,","        retained_layout,\n        run_provider,\n        links,")
edit("text/paint.rs","    let styled=if let Some(layout)=retained_layout", "    let styled=if let Some(provider)=run_provider {styled.with_runs_provider(provider)}else{styled};\n    let styled=if let Some(layout)=retained_layout")
edit(r,"    let retained_layout=ctx.viewport.as_ref().map(|cache|crate::markdown_view::cached(cache,sub,||gpui::TextLayout::default()).as_ref().clone());", "    let retained_layout=ctx.viewport.as_ref().map(|cache|crate::markdown_view::cached(cache,sub,||gpui::TextLayout::default()).as_ref().clone());\n    let run_provider=ctx.viewport.as_ref().map(|cache| {let runs=crate::markdown_view::cached(cache,sub,||flat.runs.clone());Rc::new(move||runs.as_ref().clone()) as Rc<dyn Fn()->Vec<TextRun>>});")
edit(r,"        retained_layout,\n        extra_wash:","        run_provider: run_provider.clone(),\n        retained_layout,\n        extra_wash:")
edit(r,"            Some(flat.runs.clone()),","            if run_provider.is_some(){None}else{Some(flat.runs.clone())},")
edit(r,"    let mut flat = if let Some(cache)=&ctx.viewport", "    if ctx.viewport.is_some() && ctx.theme.markdown.stream.is_none() {return document_text(runs,size,line_height,weight,ctx); }\n    let mut flat = if let Some(cache)=&ctx.viewport")
# Mixed-size token lookup must not walk every earlier styled run at the bottom.
edit("markdown_inline.rs","    tokens: Vec<InlineToken>,","    tokens: Vec<InlineToken>,\n    run_offsets: Vec<usize>,")
edit("markdown_inline.rs","        let mut offset = 0;\n        for run in &self.flat.runs {", "        let first=self.run_offsets.partition_point(|end|*end<=range.start);\n        let mut offset=if first==0 {0}else{self.run_offsets[first-1]};\n        for run in self.flat.runs.iter().skip(first) {")
edit("markdown_inline.rs","            tokens,\n            font_sans:", "            tokens,\n            run_offsets: {let mut end=0;flat.runs.iter().map(|run|{end+=run.len;end}).collect()},\n            font_sans:")
text=pending["markdown_inline.rs"]
a=text.index("    let bidi =");b=text.index("    if bidi ||",a)
old=text[a:b]
check=old[old.index("flat.text.chars()"):].strip().rstrip(";")
edit("markdown_inline.rs",old,"    let check=||"+check+";\n    let bidi=if let Some(cache)=&ctx.viewport {*crate::markdown_view::cached(cache,ctx.next_sub,check)}else{check()};\n")

# Link destinations are immutable document data too. Scrolling a giant linked
# paragraph must not clone every URL or scan all prior links for each token.
edit("text/paint.rs","    pub links: Vec<(Range<usize>, String)>,","    pub shared_links: Option<Arc<Vec<(Range<usize>, String)>>>,\n    pub links: Vec<(Range<usize>, String)>,")
edit("text/paint.rs","            links: Vec::new(),","            shared_links: None,\n            links: Vec::new(),")
edit("text/paint.rs","        links,\n        hover_link_color,","        links,\n        shared_links,\n        hover_link_color,")
edit("text/paint.rs","    let key = selection_key(element_id, sub);","    let links=shared_links.unwrap_or_else(||Arc::new(links));\n    let key = selection_key(element_id, sub);")
edit(r,"    let code_ranges = flat.code_ranges.clone();", "    let shared_links=ctx.viewport.as_ref().map(|cache|crate::markdown_view::cached(cache,sub,||Arc::new(flat.links.clone())).as_ref().clone());\n    let code_ranges = flat.code_ranges.clone();")
edit(r,"        links: flat.links.clone(),","        links: if shared_links.is_some(){Vec::new()}else{flat.links.clone()},\n        shared_links,")
edit("markdown_inline.rs","                .links\n                .iter()\n                .filter_map", "                .links\n                .iter().skip(data.flat.links.partition_point(|(range,_)|range.end<=token.range.start)).take_while(|(range,_)|range.start<token.range.end)\n                .filter_map")
