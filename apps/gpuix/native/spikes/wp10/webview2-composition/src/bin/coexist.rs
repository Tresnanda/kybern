//! W-S1 (WEBVIEW-PLATFORMS.md): can a Windows.UI.Composition `DesktopWindowTarget` (topmost) and GPUI's
//! DirectComposition target (made not topmost) share one HWND, with a WebView2 `CompositionController` under the WinComp
//! tree drawing above GPUI's swap chain?
//!
//! The window is built the way `gpui_windows` builds it (`WS_EX_NOREDIRECTIONBITMAP`, a premultiplied composition swap
//! chain as the content of an `IDCompositionVisual` on `CreateTargetForHwnd`). GPUI's frame is a teal background and a
//! magenta "popup". Above it: one document, clipped to a rounded rect minus a hole over the popup, transparent page with
//! a blue band, faded in with a cubic-bezier keyframe animation. The run then
//!
//! 1. round-trips the message bridge (page → host → page),
//! 2. clicks the page through `SendMouseInput`,
//! 3. captures the composed window (screen `BitBlt` and `PrintWindow(PW_RENDERFULLCONTENT)`) and checks pixels: page
//!    above GPUI, GPUI inside the hole and outside the rounded corner, GPUI through the transparent page,
//! 4. snapshots the page through CDP with a transparent background.
//!
//! `coexist --gpui-topmost` keeps GPUI's target topmost (upstream) to show why the fork change is needed.
//! Output: `<out>/coexist.json`, BMPs and the CDP PNG. Exit 1 when a check fails.

#[cfg(not(windows))]
fn main() {
    eprintln!("coexist runs on Windows only");
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let gpui_topmost = args.iter().any(|a| a == "--gpui-topmost");
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| ".".into());
    std::fs::create_dir_all(&out).ok();
    let code = match win::run(gpui_topmost, &out) {
        Ok(passed) => i32::from(!passed),
        Err(error) => {
            eprintln!("FAIL: {error:?}");
            std::fs::write(format!("{out}/coexist.json"), format!("{{\"error\":{:?}}}", format!("{error:?}"))).ok();
            1
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, CreateCoreWebView2CompositionControllerCompletedHandler,
        CreateCoreWebView2EnvironmentCompletedHandler, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
    };
    use windows::Foundation::TimeSpan;
    use windows::Graphics::IGeometrySource2D;
    use windows::UI::Composition::{CompositionPath, Compositor, ContainerVisual};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Direct2D::Common::{D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED, D2D_SIZE_F};
    use windows::Win32::Graphics::Direct2D::{
        D2D1CreateFactory, ID2D1Factory, ID2D1Geometry, ID2D1PathGeometry, D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_SMALL,
        D2D1_COMBINE_MODE_EXCLUDE, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_SWEEP_DIRECTION_CLOCKWISE,
    };
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::DirectComposition::{DCompositionCreateDevice, IDCompositionDevice};
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::Com::{CoInitializeEx, IStream, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
    use windows::Win32::System::WinRT::Graphics::Direct2D::{IGeometrySource2DInterop, IGeometrySource2DInterop_Impl};
    use windows::Win32::System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT};
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::{implement, Interface, HSTRING, PCWSTR, PWSTR, Result};
    use windows_numerics::{Vector2, Vector3};

    // GPUI's frame (premultiplied, opaque) and the document's geometry, in logical points.
    const TEAL: [f32; 4] = [0.0, 0.5, 0.5, 1.0];
    const MAGENTA: [f32; 4] = [0.9, 0.1, 0.6, 1.0];
    const CLIP: (f64, f64, f64, f64) = (100.0, 80.0, 600.0, 400.0);
    const RADIUS: f64 = 32.0;
    /// The popup GPUI draws, in window points; it overlaps the document's bottom right.
    const POPUP: (f64, f64, f64, f64) = (520.0, 360.0, 240.0, 160.0);
    const WRAPPER: &str = "http://tauri.localhost/embedded/spike";
    /// Transparent page with a blue band across its top 120 px (covering the clip's top corners) and an orange block under
    /// the popup's hole. The band turns green
    /// on a host message and red on a forwarded click; both report back through `chrome.webview.postMessage`.
    const PAGE: &str = r#"<!doctype html><style>html,body{margin:0;height:100%;background:transparent}#band{position:absolute;left:0;top:0;right:0;height:120px;background:rgb(0,120,255)}#under{position:absolute;left:380px;top:240px;width:220px;height:160px;background:rgb(255,140,0)}</style><div id=band></div><div id=under></div><script>
const band=document.getElementById('band');
window.chrome.webview.addEventListener('message',e=>{band.style.background='rgb(0,200,0)';requestAnimationFrame(()=>requestAnimationFrame(()=>window.chrome.webview.postMessage({kind:'pong',got:e.data})))});
addEventListener('mousedown',e=>{window.chrome.webview.postMessage({kind:'clicked',x:e.clientX,y:e.clientY,button:e.button})});
window.chrome.webview.postMessage({kind:'hello',transparent:getComputedStyle(document.body).backgroundColor});
</script>"#;

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_DESTROY {
            unsafe { PostQuitMessage(0) };
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn log(line: impl AsRef<str>) {
        println!("[coexist] {}", line.as_ref());
    }

    /// Pump messages until `done` or the deadline.
    fn pump_until(deadline: Duration, mut done: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        let mut msg = MSG::default();
        while start.elapsed() < deadline {
            if done() {
                return true;
            }
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        done()
    }

    struct Gpui {
        _device: ID3D11Device,
        _comp: IDCompositionDevice,
        _target: windows::Win32::Graphics::DirectComposition::IDCompositionTarget,
        _visual: windows::Win32::Graphics::DirectComposition::IDCompositionVisual,
        _swap: IDXGISwapChain1,
    }

    /// GPUI's half (`directx_renderer.rs`): a composition swap chain on a DComp target, topmost only for `--gpui-topmost`.
    fn gpui(hwnd: HWND, width: u32, height: u32, scale: f64, topmost: bool) -> Result<Gpui> {
        let mut device = None;
        let mut context = None;
        let mut driver = "hardware";
        let create = |kind: D3D_DRIVER_TYPE, device: &mut Option<ID3D11Device>, context: &mut Option<ID3D11DeviceContext>| unsafe {
            D3D11CreateDevice(None, kind, Default::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(device), None, Some(context))
        };
        if create(D3D_DRIVER_TYPE_HARDWARE, &mut device, &mut context).is_err() {
            driver = "warp";
            create(D3D_DRIVER_TYPE_WARP, &mut device, &mut context)?;
        }
        let (device, context) = (device.unwrap(), context.unwrap());
        let dxgi: IDXGIDevice = device.cast()?;
        let adapter = unsafe { dxgi.GetAdapter()? };
        let desc = unsafe { adapter.GetDesc()? };
        let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_owned();
        log(format!("d3d11 {driver} adapter: {name}"));
        let factory: IDXGIFactory2 = unsafe { adapter.GetParent()? };
        let swap_desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            ..Default::default()
        };
        let swap = unsafe { factory.CreateSwapChainForComposition(&device, &swap_desc, None)? };
        let comp: IDCompositionDevice = unsafe { DCompositionCreateDevice(&dxgi)? };
        let target = unsafe { comp.CreateTargetForHwnd(hwnd, topmost)? };
        let visual = unsafe { comp.CreateVisual()? };
        unsafe {
            visual.SetContent(&swap)?;
            target.SetRoot(&visual)?;
            comp.Commit()?;
        }
        let buffer: ID3D11Texture2D = unsafe { swap.GetBuffer(0)? };
        let mut view = None;
        unsafe { device.CreateRenderTargetView(&buffer, None, Some(&mut view))? };
        let view = view.unwrap();
        let context1: ID3D11DeviceContext1 = context.cast()?;
        let popup = RECT {
            left: (POPUP.0 * scale) as i32,
            top: (POPUP.1 * scale) as i32,
            right: ((POPUP.0 + POPUP.2) * scale) as i32,
            bottom: ((POPUP.1 + POPUP.3) * scale) as i32,
        };
        unsafe {
            context.ClearRenderTargetView(&view, &TEAL);
            context1.ClearView(&view, &MAGENTA, Some(&[popup]));
            swap.Present(1, DXGI_PRESENT(0)).ok()?;
        }
        Ok(Gpui { _device: device, _comp: comp, _target: target, _visual: visual, _swap: swap })
    }

    #[implement(IGeometrySource2D, IGeometrySource2DInterop)]
    struct GeometrySource(ID2D1Geometry);
    impl windows::Graphics::IGeometrySource2D_Impl for GeometrySource_Impl {}
    impl IGeometrySource2DInterop_Impl for GeometrySource_Impl {
        fn GetGeometry(&self) -> Result<ID2D1Geometry> {
            Ok(self.0.clone())
        }
        fn TryGetGeometryUsingFactory(&self, _: windows::core::Ref<'_, ID2D1Factory>) -> Result<ID2D1Geometry> {
            Ok(self.0.clone())
        }
    }

    fn rounded(factory: &ID2D1Factory, x: f32, y: f32, w: f32, h: f32, r: f32) -> Result<ID2D1PathGeometry> {
        let path = unsafe { factory.CreatePathGeometry()? };
        let sink = unsafe { path.Open()? };
        let p = |x: f32, y: f32| Vector2 { X: x, Y: y };
        let arc = |to: Vector2| D2D1_ARC_SEGMENT {
            point: to,
            size: D2D_SIZE_F { width: r, height: r },
            rotationAngle: 0.0,
            sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
            arcSize: D2D1_ARC_SIZE_SMALL,
        };
        unsafe {
            sink.BeginFigure(p(x + r, y), D2D1_FIGURE_BEGIN_FILLED);
            sink.AddLine(p(x + w - r, y));
            sink.AddArc(&arc(p(x + w, y + r)));
            sink.AddLine(p(x + w, y + h - r));
            sink.AddArc(&arc(p(x + w - r, y + h)));
            sink.AddLine(p(x + r, y + h));
            sink.AddArc(&arc(p(x, y + h - r)));
            sink.AddLine(p(x, y + r));
            sink.AddArc(&arc(p(x + r, y)));
            sink.EndFigure(D2D1_FIGURE_END_CLOSED);
            sink.Close()?;
        }
        Ok(path)
    }

    #[derive(Default)]
    struct State {
        hello: Option<String>,
        pong: Option<String>,
        clicked: Option<String>,
        cdp: Option<std::result::Result<String, String>>,
    }

    pub fn run(gpui_topmost: bool, out: &str) -> Result<bool> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        let instance = unsafe { GetModuleHandleW(None)? };
        let class = windows::core::w!("Kybern::WP10Spike");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: class, hCursor: unsafe { LoadCursorW(None, IDC_ARROW)? }, ..Default::default() };
        unsafe { RegisterClassW(&wc) };
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOREDIRECTIONBITMAP,
                class,
                windows::core::w!("Kybern WP10 coexistence spike"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                20,
                20,
                860,
                620,
                None,
                None,
                Some(instance.into()),
                None,
            )?
        };
        let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
        let mut client = RECT::default();
        unsafe { GetClientRect(hwnd, &mut client)? };
        let (width, height) = ((client.right - client.left) as u32, (client.bottom - client.top) as u32);
        log(format!("window {width}x{height} device px, scale {scale}, gpui topmost: {gpui_topmost}"));
        let _gpui = gpui(hwnd, width, height, scale, gpui_topmost)?;

        // The addon's half (webview host): a WinComp tree on the same HWND, topmost.
        let options = DispatcherQueueOptions { dwSize: size_of::<DispatcherQueueOptions>() as u32, threadType: DQTYPE_THREAD_CURRENT, apartmentType: DQTAT_COM_NONE };
        let _queue = unsafe { CreateDispatcherQueueController(options)? };
        let compositor = Compositor::new()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        let target = match unsafe { interop.CreateDesktopWindowTarget(hwnd, true) } {
            Ok(target) => target,
            Err(error) => {
                log(format!("CreateDesktopWindowTarget(topmost) failed: {error:?}"));
                let report = format!(
                    "{{\"gpuiTopmost\":{gpui_topmost},\"desktopWindowTarget\":false,\"hresult\":\"{:#010x}\",\"message\":{:?}}}",
                    error.code().0,
                    error.message()
                );
                std::fs::write(format!("{out}/coexist.json"), report).ok();
                // Expected with GPUI's target topmost (one topmost target per HWND): that run passes by failing here.
                return Ok(gpui_topmost);
            }
        };
        log("WinComp DesktopWindowTarget(topmost) created next to GPUI's DComp target");
        if gpui_topmost {
            std::fs::write(format!("{out}/coexist.json"), format!("{{\"gpuiTopmost\":true,\"desktopWindowTarget\":true}}")).ok();
            return Ok(false);
        }
        let root = compositor.CreateContainerVisual()?;
        target.SetRoot(&root)?;
        let s = scale as f32;
        let clip: ContainerVisual = compositor.CreateContainerVisual()?;
        clip.SetOffset(Vector3 { X: CLIP.0 as f32 * s, Y: CLIP.1 as f32 * s, Z: 0.0 })?;
        clip.SetSize(Vector2 { X: CLIP.2 as f32 * s, Y: CLIP.3 as f32 * s })?;
        let web = compositor.CreateContainerVisual()?;
        clip.Children()?.InsertAtTop(&web)?;
        root.Children()?.InsertAtTop(&clip)?;
        // Rounded clip minus the popup's hole (both in the clip's device pixels).
        let d2d: ID2D1Factory = unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)? };
        let base: ID2D1Geometry = rounded(&d2d, 0.0, 0.0, CLIP.2 as f32 * s, CLIP.3 as f32 * s, RADIUS as f32 * s)?.cast()?;
        let hole: ID2D1Geometry = rounded(&d2d, (POPUP.0 - CLIP.0) as f32 * s, (POPUP.1 - CLIP.1) as f32 * s, POPUP.2 as f32 * s, POPUP.3 as f32 * s, 8.0 * s)?.cast()?;
        let combined = unsafe { d2d.CreatePathGeometry()? };
        let sink = unsafe { combined.Open()? };
        unsafe {
            base.CombineWithGeometry(&hole, D2D1_COMBINE_MODE_EXCLUDE, None, 0.25, &sink)?;
            sink.Close()?;
        }
        let source: IGeometrySource2D = GeometrySource(combined.cast()?).into();
        let geometry = compositor.CreatePathGeometryWithPath(&CompositionPath::Create(&source)?)?;
        clip.SetClip(&compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
        clip.SetOpacity(0.0)?;

        let started = Instant::now();
        let folder = HSTRING::from(std::env::temp_dir().join("kybern-wp10-spike").to_string_lossy().as_ref());
        let (tx, rx) = std::sync::mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe { CreateCoreWebView2EnvironmentWithOptions(None, &folder, None, &handler).map_err(webview2_com::Error::WindowsError) }),
            Box::new(move |result, environment| {
                result?;
                tx.send(environment).ok();
                Ok(())
            }),
        )
        .map_err(to_windows)?;
        let environment = rx.recv().ok().flatten().ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
        let mut version = PWSTR::null();
        unsafe { environment.BrowserVersionString(&mut version)? };
        log(format!("WebView2 runtime {}", webview2_com::take_pwstr(version)));
        let environment10: ICoreWebView2Environment10 = environment.cast()?;
        let controller_options = unsafe { environment10.CreateCoreWebView2ControllerOptions()? };
        unsafe { controller_options.SetIsInPrivateModeEnabled(true)? };
        let (tx, rx) = std::sync::mpsc::channel();
        let env10 = environment10.clone();
        CreateCoreWebView2CompositionControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe { env10.CreateCoreWebView2CompositionControllerWithOptions(hwnd, &controller_options, &handler).map_err(webview2_com::Error::WindowsError) }),
            Box::new(move |result, controller| {
                result?;
                tx.send(controller).ok();
                Ok(())
            }),
        )
        .map_err(to_windows)?;
        let controller = rx.recv().ok().flatten().ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
        log(format!("composition controller after {} ms", started.elapsed().as_millis()));
        unsafe { controller.SetRootVisualTarget(&web)? };
        let base_controller: ICoreWebView2Controller = controller.cast()?;
        let controller3: ICoreWebView2Controller3 = controller.cast()?;
        let controller2: ICoreWebView2Controller2 = controller.cast()?;
        unsafe {
            controller3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS)?;
            controller3.SetShouldDetectMonitorScaleChanges(false)?;
            controller3.SetRasterizationScale(scale)?;
            controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
            base_controller.SetBounds(RECT { left: 0, top: 0, right: (CLIP.2 * scale) as i32, bottom: (CLIP.3 * scale) as i32 })?;
            base_controller.SetIsVisible(true)?;
        }
        let webview = unsafe { base_controller.CoreWebView2()? };
        let state = Rc::new(RefCell::new(State::default()));

        // The wrapper, served by the host only (macOS: the `tauri` scheme handler).
        unsafe { webview.AddWebResourceRequestedFilter(&HSTRING::from("http://tauri.localhost/embedded/*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)? };
        let env = environment.clone();
        let served = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            unsafe { args.Request()?.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            let response = if uri == WRAPPER {
                let stream: Option<IStream> = unsafe { SHCreateMemStream(Some(PAGE.as_bytes())) };
                unsafe { env.CreateWebResourceResponse(stream.as_ref(), 200, &HSTRING::from("OK"), &HSTRING::from("Content-Type: text/html; charset=utf-8"))? }
            } else {
                unsafe { env.CreateWebResourceResponse(None, 404, &HSTRING::from("Not Found"), &HSTRING::new())? }
            };
            unsafe { args.SetResponse(&response) }
        }));
        let mut token = Default::default();
        unsafe { webview.add_WebResourceRequested(&served, &mut token)? };
        let bridge_state = state.clone();
        let bridge_view = webview.clone();
        let bridge = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            unsafe { args.Source(&mut source)? };
            let source = webview2_com::take_pwstr(source);
            let mut json = PWSTR::null();
            unsafe { args.WebMessageAsJson(&mut json)? };
            let json = webview2_com::take_pwstr(json);
            log(format!("message from {source}: {json}"));
            if source != WRAPPER {
                return Ok(());
            }
            let mut state = bridge_state.borrow_mut();
            if json.contains("\"hello\"") {
                state.hello = Some(json);
                unsafe { bridge_view.PostWebMessageAsJson(&HSTRING::from(r#"{"ping":1}"#))? };
            } else if json.contains("\"pong\"") {
                state.pong = Some(json);
            } else if json.contains("\"clicked\"") {
                state.clicked = Some(json);
            }
            Ok(())
        }));
        unsafe { webview.add_WebMessageReceived(&bridge, &mut token)? };
        unsafe { webview.Navigate(&HSTRING::from(WRAPPER))? };

        let bridged = pump_until(Duration::from_secs(30), || state.borrow().pong.is_some());
        log(format!("bridge round trip: {bridged} after {} ms", started.elapsed().as_millis()));

        // `present`: fade in on the compositor's clock with the app's default curve.
        let curve = compositor.CreateCubicBezierEasingFunction(Vector2 { X: 0.23, Y: 1.0 }, Vector2 { X: 0.32, Y: 1.0 })?;
        let fade = compositor.CreateScalarKeyFrameAnimation()?;
        fade.InsertKeyFrame(0.0, 0.0)?;
        fade.InsertKeyFrameWithEasingFunction(1.0, 1.0, &curve)?;
        fade.SetDuration(TimeSpan { Duration: 3_000_000 })?;
        clip.StartAnimation(&HSTRING::from("Opacity"), &fade)?;
        pump_until(Duration::from_millis(600), || false);
        // A press forwarded to the page, in the web visual's own pixels (macOS: a click on the WKWebView).
        let press = POINT { x: (200.0 * scale) as i32, y: (60.0 * scale) as i32 };
        unsafe {
            controller.SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE, 0, press)?;
            controller.SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON, 0, press)?;
            controller.SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE, 0, press)?;
        }
        let clicked = pump_until(Duration::from_secs(5), || state.borrow().clicked.is_some());
        log(format!("forwarded click reached the page: {clicked}"));

        // Bring the window to the front for the screen capture, then let DWM present.
        unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            let _ = SetForegroundWindow(hwnd);
        }
        pump_until(Duration::from_millis(800), || false);
        let screen = capture_screen(hwnd, width, height, &format!("{out}/coexist-screen.bmp"));
        let printed = capture_print(hwnd, width, height, &format!("{out}/coexist-printwindow.bmp"));

        // CDP snapshot with a transparent background (`snapshot` / `snapshotRect`).
        let cdp_state = state.clone();
        let shot_view = webview.clone();
        let shoot = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| {
            let cdp_state = cdp_state.clone();
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                cdp_state.borrow_mut().cdp = Some(result.map(|_| json).map_err(|e| format!("{e:?}")));
                Ok(())
            }));
            unsafe {
                shot_view.CallDevToolsProtocolMethod(
                    &HSTRING::from("Page.captureScreenshot"),
                    &HSTRING::from(r#"{"format":"png","fromSurface":true,"clip":{"x":0,"y":0,"width":600,"height":400,"scale":1}}"#),
                    &done,
                )
            }
        }));
        unsafe {
            webview.CallDevToolsProtocolMethod(
                &HSTRING::from("Emulation.setDefaultBackgroundColorOverride"),
                &HSTRING::from(r#"{"color":{"r":0,"g":0,"b":0,"a":0}}"#),
                &shoot,
            )?
        };
        pump_until(Duration::from_secs(10), || state.borrow().cdp.is_some());
        let cdp = state.borrow_mut().cdp.take();
        let cdp_png = match &cdp {
            Some(Ok(json)) => json.split("\"data\":\"").nth(1).and_then(|rest| rest.split('"').next()).map(base64),
            _ => None,
        };
        if let Some(png) = &cdp_png {
            std::fs::write(format!("{out}/coexist-cdp.png"), png).ok();
        }
        // PNG color type 6 (RGBA) at byte 25; the first IDAT is compressed, so alpha is checked on the Mac from the file.
        let cdp_rgba = cdp_png.as_ref().is_some_and(|png| png.len() > 26 && png[25] == 6);

        // Pixel checks on the composed window. Points in logical window coordinates.
        let mut checks = Vec::new();
        let mut passed = bridged && clicked;
        for (name, image) in [("screen", &screen), ("printwindow", &printed)] {
            let Ok(image) = image else {
                checks.push(format!("{{\"capture\":{name:?},\"error\":{:?}}}", format!("{:?}", image.as_ref().err())));
                continue;
            };
            let at = |x: f64, y: f64| image.pixel((x * scale) as u32, (y * scale) as u32);
            let expect = [
                ("page band above GPUI (green after the host message)", at(CLIP.0 + 300.0, CLIP.1 + 60.0), [0u8, 200, 0], 40),
                ("transparent page shows GPUI", at(CLIP.0 + 200.0, CLIP.1 + 250.0), [0, 128, 128], 30),
                ("rounded corner clips the page", at(CLIP.0 + 2.0, CLIP.1 + 2.0), [0, 128, 128], 30),
                ("hole cuts the opaque page: GPUI's popup shows", at(POPUP.0 + 40.0, POPUP.1 + 40.0), [230, 26, 153], 40),
                ("opaque page next to the hole stays above GPUI", at(CLIP.0 + 400.0, CLIP.1 + 260.0), [255, 140, 0], 40),
                ("GPUI outside the document", at(40.0, 40.0), [0, 128, 128], 30),
            ];
            for (label, got, want, tolerance) in expect {
                let ok = got.iter().zip(want).all(|(g, w)| (*g as i32 - w as i32).abs() <= tolerance);
                if name == "screen" {
                    passed &= ok;
                }
                checks.push(format!("{{\"capture\":{name:?},\"check\":{label:?},\"ok\":{ok},\"got\":{got:?},\"want\":{want:?}}}"));
                log(format!("{name}: {label}: {} got {got:?} want {want:?}", if ok { "ok" } else { "FAIL" }));
            }
        }
        let report = format!(
            "{{\"gpuiTopmost\":false,\"desktopWindowTarget\":true,\"scale\":{scale},\"bridge\":{bridged},\"hello\":{},\"pong\":{},\"click\":{},\"cdpSnapshot\":{},\"cdpRgba\":{cdp_rgba},\"checks\":[{}],\"passed\":{passed}}}",
            state.borrow().hello.clone().unwrap_or("null".into()),
            state.borrow().pong.clone().unwrap_or("null".into()),
            state.borrow().clicked.clone().unwrap_or("null".into()),
            cdp_png.is_some(),
            checks.join(",")
        );
        std::fs::write(format!("{out}/coexist.json"), report).ok();
        log(format!("passed: {passed}"));
        unsafe {
            let _ = base_controller.Close();
            let _ = DestroyWindow(hwnd);
        }
        Ok(passed)
    }

    fn to_windows(error: webview2_com::Error) -> windows::core::Error {
        match error {
            webview2_com::Error::WindowsError(error) => error,
            other => windows::core::Error::new(windows::Win32::Foundation::E_FAIL, format!("{other:?}")),
        }
    }

    pub struct Image {
        width: u32,
        height: u32,
        /// BGRA, top-down.
        bgra: Vec<u8>,
    }

    impl Image {
        fn pixel(&self, x: u32, y: u32) -> [u8; 3] {
            if x >= self.width || y >= self.height {
                return [0, 0, 0];
            }
            let i = ((y * self.width + x) * 4) as usize;
            [self.bgra[i + 2], self.bgra[i + 1], self.bgra[i]]
        }

        fn write_bmp(&self, path: &str) {
            let size = self.bgra.len() as u32;
            let mut file = Vec::with_capacity(size as usize + 54);
            file.extend_from_slice(b"BM");
            file.extend_from_slice(&(54 + size).to_le_bytes());
            file.extend_from_slice(&0u32.to_le_bytes());
            file.extend_from_slice(&54u32.to_le_bytes());
            file.extend_from_slice(&40u32.to_le_bytes());
            file.extend_from_slice(&(self.width as i32).to_le_bytes());
            file.extend_from_slice(&(-(self.height as i32)).to_le_bytes());
            file.extend_from_slice(&1u16.to_le_bytes());
            file.extend_from_slice(&32u16.to_le_bytes());
            file.extend_from_slice(&[0u8; 24]);
            file.extend_from_slice(&self.bgra);
            std::fs::write(path, file).ok();
        }
    }

    fn read_dib(dc: HDC, bitmap: HBITMAP, width: u32, height: u32) -> Image {
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        unsafe { GetDIBits(dc, bitmap, 0, height, Some(bgra.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS) };
        Image { width, height, bgra }
    }

    /// The composed desktop under the window's client area (what the user sees).
    fn capture_screen(hwnd: HWND, width: u32, height: u32, path: &str) -> Result<Image> {
        let mut origin = POINT::default();
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin);
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
            let old = SelectObject(memory, bitmap.into());
            BitBlt(memory, 0, 0, width as i32, height as i32, Some(screen), origin.x, origin.y, SRCCOPY | CAPTUREBLT)?;
            SelectObject(memory, old);
            let image = read_dib(memory, bitmap, width, height);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            image.write_bmp(path);
            Ok(image)
        }
    }

    /// `PrintWindow` with `PW_RENDERFULLCONTENT` (DWM's copy of the window, foreign visuals included).
    fn capture_print(hwnd: HWND, width: u32, height: u32, path: &str) -> Result<Image> {
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
            let old = SelectObject(memory, bitmap.into());
            // PW_CLIENTONLY | PW_RENDERFULLCONTENT
            let ok = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(1 | 2)).as_bool();
            SelectObject(memory, old);
            let image = read_dib(memory, bitmap, width, height);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            if !ok {
                return Err(windows::core::Error::from_win32());
            }
            image.write_bmp(path);
            Ok(image)
        }
    }

    fn base64(text: &str) -> Vec<u8> {
        let value = |c: u8| match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        };
        let digits: Vec<u8> = text.bytes().filter_map(value).collect();
        digits
            .chunks(4)
            .flat_map(|c| {
                let n = c.iter().enumerate().fold(0u32, |n, (i, d)| n | (*d as u32) << (18 - 6 * i));
                let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
                bytes.into_iter().take(c.len().saturating_sub(1))
            })
            .collect()
    }

    #[allow(dead_code)]
    fn _unused(_: PCWSTR) {}
}
