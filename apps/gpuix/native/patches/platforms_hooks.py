# ADE-52: the native-crate half of the Linux/Windows port. Executed last from apply_hooks.py.
#
# Off macOS, GPUI runs on its own `gpuix-ui` thread (upstream's model), so the
# macOS-only `update_window` / `update_window_without_view` that ~40 Kybern hooks
# call are given a portable twin: the closure is boxed into one generic
# `UiCommand::Run`, runs on the UI thread against the same window, and the JS
# thread waits for its result (2 s cap, like upstream's synchronous queries).
# Hooks stay written once; a closure only has to be `Send + 'static`.
# Thread-local registries that hooks read *outside* such a closure stay on the
# JS thread and see nothing there; PORTING-PLATFORMS.md lists the known ones.
r = "renderer.rs"
edit(r, "#[cfg(any(target_os = \"windows\", target_os = \"linux\", target_os = \"freebsd\"))]\nenum UiCommand {\n    Invalidate,",
     "#[cfg(any(target_os = \"windows\", target_os = \"linux\", target_os = \"freebsd\"))]\nenum UiCommand {\n"
     "    /// Kybern: one window update from a hook, run on the UI thread.\n"
     "    Run(Box<dyn FnOnce(gpui::WindowHandle<GpuixView>, &mut gpui::AsyncApp) + Send>),\n"
     "    Invalidate,")
edit(r, "            UiCommand::Invalidate => refresh_ui_window(window, cx),",
     "            UiCommand::Run(job) => {\n                job(window, cx);\n                Ok(())\n            }\n"
     "            UiCommand::Invalidate => refresh_ui_window(window, cx),")
edit(r, "        *self.ui_commands.lock().unwrap() = Some(command_sender);",
     "        *UI_BRIDGE.lock().unwrap() = Some(command_sender.clone());\n"
     "        *self.ui_commands.lock().unwrap() = Some(command_sender);")
edit(r, "#[cfg(target_os = \"macos\")]\nfn invalidate_window() -> Result<()> {", '''#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
static UI_BRIDGE: std::sync::Mutex<Option<mpsc::UnboundedSender<UiCommand>>> = std::sync::Mutex::new(None);

/// Kybern: run `job` on the GPUI UI thread and wait for its result.
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn run_on_ui_thread<R: Send + 'static>(
    job: impl FnOnce(gpui::WindowHandle<GpuixView>, &mut gpui::AsyncApp) -> anyhow::Result<R> + Send + 'static,
) -> Result<R> {
    if std::thread::current().name() == Some("gpuix-ui") {
        return Err(Error::from_reason("A window update was requested from the GPUI UI thread itself"));
    }
    let sender = UI_BRIDGE
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?;
    let (response, receiver) = sync_channel(1);
    sender
        .unbounded_send(UiCommand::Run(Box::new(move |window, cx| {
            response.send(job(window, cx).map_err(|error| error.to_string())).ok();
        })))
        .map_err(|_| Error::from_reason("The GPUI UI thread is not running"))?;
    recv_ui_response(receiver, "a window update")?.map_err(Error::from_reason)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn update_window<R: Send + 'static>(
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R + Send + 'static,
) -> Result<R> {
    run_on_ui_thread(move |window, cx| window.update(cx, update))
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn update_window_without_view<R: Send + 'static>(
    update: impl FnOnce(&mut gpui::Window, &mut gpui::App) -> R + Send + 'static,
) -> Result<R> {
    run_on_ui_thread(move |window, cx| {
        gpui::AnyWindowHandle::from(window).update(cx, move |_view, window, cx| update(window, cx))
    })
}

#[cfg(target_os = "macos")]
fn invalidate_window() -> Result<()> {''')
# Kybern's bounds carry a clip vector now, so they are no longer Copy.
edit(r, "            return Ok(tree.elements_at(x, y, &|id| bounds.get(&id).copied()));",
     "            return Ok(tree.elements_at(x, y, &|id| bounds.get(&id).cloned()));")

# Kybern napi methods that were stubbed off macOS only because `update_window` was
# macOS-only now share the macOS body: drop the gate and the "macOS-only" stub.
import re as _re
_gated = _re.compile(
    r'( *)#\[cfg\(target_os = "macos"\)\]\n(\s*return update_window(?:_without_view)?\((?:(?!#\[cfg|\n    pub fn ).)*?)\n'
    r'\s*#\[cfg\(not\(target_os = "macos"\)\)\]\n'
    r'\s*(?:Err\(Error::from_reason\("([^"]*) macOS-only"\)\)|\{ let _ = [^;]*; Err\(Error::from_reason\("([^"]*) macOS-only"\)\) \})\n',
    _re.S)
# Kept: the title-bar action reads the macOS "double-click to zoom" default.
_keep = {"Title-bar actions are currently"}
def _unify(match):
    what = match.group(3) or match.group(4)
    if what in _keep:
        return match.group(0)
    _unified.append(what)
    return match.group(1) + match.group(2).lstrip() + "\n"
_unified = []
pending[r] = _gated.sub(_unify, pending[r])
if len(_unified) != 12:
    hook_check.missing(f"{r}: expected 12 macOS-only stubs to unify, found {len(_unified)}: {_unified}")
# The save panel: the same GPUI prompt, opened and settled on the UI thread.
edit(r, """        #[cfg(not(target_os = "macos"))]
        {
            let _ = (directory, suggested_name);
            deferred.reject(Error::from_reason("The save panel is currently macOS-only"));
        }""", """        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        run_on_ui_thread(move |_window, cx| {
            let executor = cx.background_executor().clone();
            let receiver = cx.update(|cx| cx.prompt_for_new_path(std::path::Path::new(&directory), suggested_name.as_deref()));
            executor
                .spawn(async move {
                    let result = receiver
                        .await
                        .map_err(|_| Error::from_reason("The save panel closed without a result"))
                        .and_then(|result| path_prompt_result(result.map(|path| path.map(|path| vec![path]))));
                    match result {
                        Ok(paths) => deferred.resolve(Box::new(move |_env| Ok(paths))),
                        Err(error) => deferred.reject(error),
                    }
                })
                .detach();
            Ok(())
        })?;
""")
# Upstream's paint registries are thread-locals of the painting thread; off macOS
# the test-facing readers ask the UI thread instead of reading the JS thread's empty copy.
edit(r, """    pub fn get_painted_text(&self) -> Vec<String> {
        crate::text::painted_text()""", """    pub fn get_painted_text(&self) -> Vec<String> {
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        if let Ok(text) = run_on_ui_thread(|_, _| Ok(crate::text::painted_text())) {
            return text;
        }
        crate::text::painted_text()""")
edit(r, """    pub fn get_painted_highlights(&self) -> Vec<crate::element_tree::HighlightMatch> {
        crate::text::painted_highlights()""", """    pub fn get_painted_highlights(&self) -> Vec<crate::element_tree::HighlightMatch> {
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        if let Ok(highlights) = run_on_ui_thread(|_, _| Ok(crate::text::painted_highlights())) {
            return highlights.into_iter().map(Into::into).collect();
        }
        crate::text::painted_highlights()""")
(src / r).write_text(pending[r])
