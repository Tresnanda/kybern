edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod frame_clock;")
edit("renderer.rs", "    layout_observers: crate::layout_observer::Shared,", "    layout_observers: crate::layout_observer::Shared,\n    frame_clock: crate::frame_clock::Shared,")
edit("renderer.rs", "            layout_observers: Default::default(),", "            layout_observers: Default::default(),\n            frame_clock: Default::default(),")
edit("renderer.rs", "    pub fn zoom_window(&self) -> Result<()> {", '''    pub fn set_frame_wake_callback(&self, callback: Option<ThreadsafeFunction<serde_json::Value>>) {
        crate::frame_clock::set_waker(callback);
    }
    #[napi]
    pub fn acknowledge_frame_wake(&self) { crate::frame_clock::acknowledge_wake(); }
    #[napi]
    pub fn subscribe_animation_frames(&self, callback: ThreadsafeFunction<serde_json::Value>) -> Result<u32> {
        update_window(move |view, window, _| crate::frame_clock::add(view.frame_clock.clone(), callback, window))?
    }
    #[napi]
    pub fn acknowledge_animation_frame(&self, token: u32) -> Result<()> {
        update_window(move |view, _, _| crate::frame_clock::ack(&view.frame_clock, token))
    }
    #[napi]
    pub fn unsubscribe_animation_frames(&self, token: u32) -> Result<()> {
        update_window(move |view, _, _| crate::frame_clock::remove(&view.frame_clock, token))
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')
edit("renderer.rs", "        is_resizable: options.resizable.unwrap_or(true),", '''        // Display-rate inactive motion parks when the window is occluded.
        // Keep the previous cadence selectable for diagnostic comparisons.
        inactive_frame_interval: if std::env::var("KYBERN_FULL_RATE").as_deref()==Ok("0") { Some(std::time::Duration::from_micros(33_333)) } else { None },
        is_resizable: options.resizable.unwrap_or(true),''')

# Set rotation before id() wraps the SVG in Stateful<Svg>.
edit("custom_elements/img.rs", "        let mut icon = gpui::svg()\n            .data(bytes)", """        let degrees = ctx.props.get("rotate").and_then(serde_json::Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0);
        let mut icon = gpui::svg()
            .with_transformation(gpui::Transformation::rotate(gpui::radians(degrees.to_radians() as f32)))
            .data(bytes)""")
