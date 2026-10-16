w='crates/gpui/src/window.rs'
pending[w] += '''
thread_local! {
    static KYBERN_LAYOUT_NS: std::cell::Cell<u128> = const { std::cell::Cell::new(0) };
    static KYBERN_LAYOUT_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
'''
edit(w,'    pub fn draw(&mut self, cx: &mut App) -> ArenaClearNeeded {','''    pub fn draw(&mut self, cx: &mut App) -> ArenaClearNeeded {
        static COST: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let kybern_started = COST.get_or_init(|| std::env::var_os("KYBERN_FRAME_COSTS").is_some()).then(std::time::Instant::now);
        if kybern_started.is_some() { KYBERN_LAYOUT_NS.set(0); KYBERN_LAYOUT_CALLS.set(0); }''')
edit(w,'        arena_scope.exit(&cx.element_arena)','''        if let Some(started) = kybern_started {
            eprintln!("[kybern-work] renderMs={:.3} layoutMs={:.3} layoutCalls={}", started.elapsed().as_secs_f64()*1000.0, KYBERN_LAYOUT_NS.get() as f64 / 1e6, KYBERN_LAYOUT_CALLS.get());
        }
        arena_scope.exit(&cx.element_arena)''')
edit(w,'        let mut layout_engine = self.layout_engine.take().unwrap();','''        static COST: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let kybern_started = COST.get_or_init(|| std::env::var_os("KYBERN_FRAME_COSTS").is_some()).then(std::time::Instant::now);
        let mut layout_engine = self.layout_engine.take().unwrap();''')
edit(w,'        self.layout_engine = Some(layout_engine);','''        self.layout_engine = Some(layout_engine);
        if let Some(started) = kybern_started {
            KYBERN_LAYOUT_NS.set(KYBERN_LAYOUT_NS.get()+started.elapsed().as_nanos());
            KYBERN_LAYOUT_CALLS.set(KYBERN_LAYOUT_CALLS.get()+1);
        }''')
