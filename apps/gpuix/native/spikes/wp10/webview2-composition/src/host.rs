//! WebView2 documents hosted in Windows.UI.Composition over GPUI's DirectComposition swap chain.
//!
//! Tree on GPUI's HWND (all on the `gpuix-ui` thread, which owns the HWND and pumps its messages):
//!
//! ```text
//! DComp target, NOT topmost (gpui_windows, one-word fork change from `CreateTargetForHwnd(hwnd, true)`)
//!   └─ GPUI swap chain visual
//! WinComp DesktopWindowTarget, topmost (this module)
//!   └─ root ContainerVisual
//!        └─ per document: clip ContainerVisual  (offset, size, CompositionGeometricClip, Opacity/Scale animations)
//!             ├─ web ContainerVisual            (WebView2 RootVisualTarget, offset for device mode)
//!             └─ shade SpriteVisual             (black, `dim` opacity from a modal occlusion)
//! ```
//!
//! GPUI popups draw *under* the documents, so, exactly as on macOS, every popup's rect is cut out of the documents
//! below it (`mask::Mask`). Pointer events reach GPUI's window procedure; a filter installed there (fork hook) calls
//! [`Document::forward_mouse`] and swallows the event when the document's mask is hit.

use std::cell::RefCell;
use std::rc::Rc;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    CreateCoreWebView2CompositionControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    CursorChangedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
};
use windows_numerics::{Vector2, Vector3};
use windows::Foundation::TimeSpan;
use windows::Graphics::IGeometrySource2D;
use windows::UI::Color;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionPath, Compositor, ContainerVisual, SpriteVisual};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Direct2D::Common::{D2D_SIZE_F, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED};
use windows::Win32::Graphics::Direct2D::{
    D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_SMALL, D2D1_COMBINE_MODE, D2D1_COMBINE_MODE_EXCLUDE, D2D1_COMBINE_MODE_INTERSECT,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1CreateFactory, ID2D1Factory, ID2D1Geometry,
    ID2D1PathGeometry,
};
use windows::Win32::System::Com::IStream;
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::Graphics::Direct2D::{IGeometrySource2DInterop, IGeometrySource2DInterop_Impl};
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
};
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::{
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
    WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};
use windows::core::{BOOL, HSTRING, Interface, PWSTR, Result, implement};

use crate::mask::{Mask, Occlusion, RoundedRect};

/// The wrapper's origin. Already in the daemon's preview `frame-ancestors` (`previews/files.rs` `FRAME_ANCESTORS`,
/// `http://tauri.localhost`), which is what Tauri serves its own assets from on Windows.
const WRAPPER_PREFIX: &str = "http://tauri.localhost/embedded/";

/// `webview.ts` `webDocument` posts with `window.webkit.messageHandlers.kybern.postMessage`. Until that line becomes
/// per-platform, this shim (installed for the wrapper document only) maps it onto `chrome.webview.postMessage`.
const BRIDGE_SHIM: &str = "if(location.href.startsWith('http://tauri.localhost/embedded/')){window.webkit={messageHandlers:{kybern:{postMessage:m=>window.chrome.webview.postMessage(m)}}}}";

/// Events the host sends to JS (`kybern_web_next` on macOS). A JSON string, so the same `webview.ts` reader works.
pub type Emit = Rc<dyn Fn(String)>;

/// One per GPUI window.
pub struct Composition {
    _queue: windows::System::DispatcherQueueController,
    compositor: Compositor,
    _target: DesktopWindowTarget,
    root: ContainerVisual,
    d2d: ID2D1Factory,
}

impl Composition {
    /// Must run on the thread that owns `hwnd` (GPUI's UI thread), which already pumps Win32 messages; the
    /// DispatcherQueue rides on that pump. COM is already initialized there by GPUI (OLE for drag and drop).
    pub fn new(hwnd: HWND) -> Result<Self> {
        let options = DispatcherQueueOptions {
            dwSize: size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_NONE,
        };
        let queue = unsafe { CreateDispatcherQueueController(options)? };
        let compositor = Compositor::new()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        // Topmost: above GPUI's DirectComposition target, which the fork creates as not topmost.
        let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, true)? };
        let root = compositor.CreateContainerVisual()?;
        target.SetRoot(&root)?;
        let d2d: ID2D1Factory = unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)? };
        Ok(Self { _queue: queue, compositor, _target: target, root, d2d })
    }
}

/// Created once per app with an InPrivate controller per document (macOS: `nonPersistentDataStore`). The user data
/// folder still exists (`%LOCALAPPDATA%\kybern-gpuix\WebView2`); InPrivate keeps cookies and storage out of it.
pub fn create_environment(user_data_folder: &str) -> webview2_com::Result<ICoreWebView2Environment> {
    let folder = HSTRING::from(user_data_folder);
    let (tx, rx) = std::sync::mpsc::channel();
    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            CreateCoreWebView2EnvironmentWithOptions(None, &folder, None, &handler).map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |result, environment| {
            result?;
            tx.send(environment).ok();
            Ok(())
        }),
    )?;
    rx.recv().map_err(|_| webview2_com::Error::SendError)?.ok_or(webview2_com::Error::TaskCanceled)
}

pub struct Document {
    pub id: String,
    pub category: String,
    clip: ContainerVisual,
    web: ContainerVisual,
    shade: SpriteVisual,
    pub controller: ICoreWebView2CompositionController,
    pub webview: ICoreWebView2,
    compositor: Compositor,
    d2d: ID2D1Factory,
    /// Window points of the clip box, its own radius and the ancestors' rounded clips (last `place`).
    placed: Option<(RoundedRect, f64, Vec<[f64; 8]>, i64)>,
    pub mask: Mask,
    /// Device pixels per point for this window.
    scale: f64,
    /// `CursorChanged` → the window procedure's `WM_SETCURSOR` over the document.
    pub cursor: Rc<RefCell<u32>>,
}

impl Document {
    /// `create`: `html` is `webview.ts` `webDocument(...)`, served at `http://tauri.localhost/embedded/<id>`.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        composition: &Composition,
        environment: &ICoreWebView2Environment,
        hwnd: HWND,
        id: &str,
        category: &str,
        html: String,
        allowed_origins: Vec<String>,
        scale: f64,
        emit: Emit,
    ) -> webview2_com::Result<Document> {
        let compositor = composition.compositor.clone();
        let clip = compositor.CreateContainerVisual()?;
        let web = compositor.CreateContainerVisual()?;
        let shade = compositor.CreateSpriteVisual()?;
        shade.SetBrush(&compositor.CreateColorBrushWithColor(Color { A: 0, R: 0, G: 0, B: 0 })?)?;
        clip.Children()?.InsertAtTop(&web)?;
        clip.Children()?.InsertAtTop(&shade)?;
        clip.SetIsVisible(false)?;
        composition.root.Children()?.InsertAtTop(&clip)?;

        let environment10: ICoreWebView2Environment10 = environment.cast()?;
        let options = unsafe { environment10.CreateCoreWebView2ControllerOptions()? };
        unsafe { options.SetIsInPrivateModeEnabled(true)? };
        let (tx, rx) = std::sync::mpsc::channel();
        CreateCoreWebView2CompositionControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                environment10
                    .CreateCoreWebView2CompositionControllerWithOptions(hwnd, &options, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |result, controller| {
                result?;
                tx.send(controller).ok();
                Ok(())
            }),
        )?;
        let controller = rx.recv().map_err(|_| webview2_com::Error::SendError)?.ok_or(webview2_com::Error::TaskCanceled)?;
        unsafe { controller.SetRootVisualTarget(&web)? };

        let base: ICoreWebView2Controller = controller.cast()?;
        let scaled: ICoreWebView2Controller3 = controller.cast()?;
        unsafe {
            // Raw pixels: `place` already knows the window's scale; GPUI handles WM_DPICHANGED and re-places.
            scaled.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS)?;
            scaled.SetShouldDetectMonitorScaleChanges(false)?;
            scaled.SetRasterizationScale(scale)?;
            if category == "visual" {
                // Fully transparent is supported (semi-transparent is not): the thread's material shows through.
                let background: ICoreWebView2Controller2 = controller.cast()?;
                background.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
            }
        }
        let webview = unsafe { base.CoreWebView2()? };
        let settings = unsafe { webview.Settings()? };
        unsafe {
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetIsWebMessageEnabled(true)?;
            settings.SetIsZoomControlEnabled(false)?;
        }

        let wrapper = format!("{WRAPPER_PREFIX}{id}");
        Self::serve_wrapper(environment, &webview, wrapper.clone(), html)?;
        Self::guard_navigation(&webview, wrapper.clone(), allowed_origins, id, emit.clone())?;
        Self::bridge(&webview, wrapper.clone(), id, emit.clone())?;
        let cursor = Rc::new(RefCell::new(0u32));
        Self::follow_cursor(&controller, cursor.clone())?;
        Self::shortcuts(&base, id, emit.clone())?;

        unsafe {
            webview.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(BRIDGE_SHIM), None)?;
            webview.Navigate(&HSTRING::from(wrapper))?;
        }
        emit(format!(r#"{{"id":{id:?},"type":"created"}}"#));
        Ok(Document {
            id: id.to_owned(),
            category: category.to_owned(),
            clip,
            web,
            shade,
            controller,
            webview,
            compositor,
            d2d: composition.d2d.clone(),
            placed: None,
            mask: Mask::default(),
            scale,
            cursor,
        })
    }

    /// macOS: the `tauri` WKURLSchemeHandler. Only the exact wrapper URL is answered.
    fn serve_wrapper(environment: &ICoreWebView2Environment, webview: &ICoreWebView2, wrapper: String, html: String) -> Result<()> {
        let environment = environment.clone();
        unsafe {
            webview.AddWebResourceRequestedFilter(&HSTRING::from(format!("{WRAPPER_PREFIX}*")), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        }
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let request = unsafe { args.Request()? };
            let mut uri = PWSTR::null();
            unsafe { request.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            let response = if uri == wrapper {
                let stream: Option<IStream> = unsafe { SHCreateMemStream(Some(html.as_bytes())) };
                unsafe {
                    environment.CreateWebResourceResponse(
                        stream.as_ref(),
                        200,
                        &HSTRING::from("OK"),
                        &HSTRING::from("Content-Type: text/html; charset=utf-8"),
                    )?
                }
            } else {
                unsafe { environment.CreateWebResourceResponse(None, 404, &HSTRING::from("Not Found"), &HSTRING::new())? }
            };
            unsafe { args.SetResponse(&response) }
        }));
        let mut token = Default::default();
        unsafe { webview.add_WebResourceRequested(&handler, &mut token) }
    }

    /// macOS: `decidePolicyForNavigationAction` / `…Response`. Only the wrapper is top level; frames stay on the
    /// ticket's origins (redirects arrive as NavigationStarting with `IsRedirected`, so they are checked too); no new
    /// windows. Child sandboxing and CSP are the daemon's, unchanged.
    fn guard_navigation(webview: &ICoreWebView2, wrapper: String, allowed: Vec<String>, id: &str, emit: Emit) -> Result<()> {
        let mut token = Default::default();
        let (top_emit, top_id) = (emit.clone(), id.to_owned());
        let top = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            if uri != wrapper {
                unsafe { args.SetCancel(true)? };
                top_emit(format!(r#"{{"id":{top_id:?},"type":"externalNavigation","url":{uri:?}}}"#));
            }
            Ok(())
        }));
        unsafe { webview.add_NavigationStarting(&top, &mut token)? };
        let (frame_emit, frame_id) = (emit.clone(), id.to_owned());
        let frames = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            if !(uri.starts_with("about:") || allowed.iter().any(|origin| origin_of(&uri).as_deref() == Some(origin.as_str()))) {
                unsafe { args.SetCancel(true)? };
                frame_emit(format!(r#"{{"id":{frame_id:?},"type":"externalNavigation","url":{uri:?}}}"#));
            }
            Ok(())
        }));
        unsafe { webview.add_FrameNavigationStarting(&frames, &mut token)? };
        let popups = NewWindowRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe { args.SetHandled(true)? };
            }
            Ok(())
        }));
        unsafe { webview.add_NewWindowRequested(&popups, &mut token) }
    }

    /// macOS: the `kybern` script message handler. `WebMessageReceived` on the CoreWebView2 fires for the top-level
    /// document only (an iframe needs `ICoreWebView2Frame2` handlers, which we never add), and the source is checked.
    fn bridge(webview: &ICoreWebView2, wrapper: String, id: &str, emit: Emit) -> Result<()> {
        let id = id.to_owned();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            unsafe { args.Source(&mut source)? };
            if webview2_com::take_pwstr(source) != wrapper {
                return Ok(());
            }
            let mut json = PWSTR::null();
            unsafe { args.WebMessageAsJson(&mut json)? };
            let data = webview2_com::take_pwstr(json);
            if data.starts_with('{') && data.len() <= 65536 {
                emit(format!(r#"{{"id":{id:?},"type":"message","data":{data}}}"#));
            }
            Ok(())
        }));
        let mut token = Default::default();
        unsafe { webview.add_WebMessageReceived(&handler, &mut token) }
    }

    fn follow_cursor(controller: &ICoreWebView2CompositionController, cursor: Rc<RefCell<u32>>) -> Result<()> {
        let handler = CursorChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(sender) = sender {
                let mut id = 0u32;
                unsafe { sender.SystemCursorId(&mut id)? };
                *cursor.borrow_mut() = id;
            }
            Ok(())
        }));
        let mut token = Default::default();
        unsafe { controller.add_CursorChanged(&handler, &mut token) }
    }

    /// macOS: the ⌘ key monitor. Ctrl here (the `isPrimary` modifier off macOS); the same key list.
    fn shortcuts(controller: &ICoreWebView2Controller, id: &str, emit: Emit) -> Result<()> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
        let id = id.to_owned();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            unsafe { args.KeyEventKind(&mut kind)? };
            let mut key = 0u32;
            unsafe { args.VirtualKey(&mut key)? };
            let down = |vk: u16| unsafe { GetKeyState(vk as i32) } < 0;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || !down(VK_CONTROL.0) {
                return Ok(());
            }
            let alt = down(VK_MENU.0);
            let name = match key {
                0x4C => "l",
                0x52 => "r",
                0x4E => "n",
                0x42 => "b",
                0x4B => "k",
                0x4A => "j",
                0xDB => "[",
                0xDD => "]",
                0x26 => "up",
                0xBC => ",",
                0xDC => "\\",
                0x50 => "p",
                _ => return Ok(()),
            };
            if alt != (name == "p") {
                return Ok(());
            }
            unsafe { args.SetHandled(true)? };
            emit(format!(
                r#"{{"id":{id:?},"type":"shortcut","key":{name:?},"modifiers":{{"cmd":false,"ctrl":true,"alt":{alt},"shift":{}}}}}"#,
                down(VK_SHIFT.0)
            ));
            Ok(())
        }));
        let mut token = Default::default();
        unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
    }

    /// `place`: window points in, device pixels out. `offset`/`logical` are the document's own box inside the clip
    /// (device mode); `layer` is its occlusion order.
    #[allow(clippy::too_many_arguments)]
    pub fn place(&mut self, clip: RoundedRect, radius: f64, rounded_clips: Vec<[f64; 8]>, offset: (f64, f64), logical: (f64, f64), visible: bool, layer: i64, occlusions: &[Occlusion]) -> Result<()> {
        let s = self.scale;
        self.clip.SetOffset(Vector3 { X: (clip.x * s) as f32, Y: (clip.y * s) as f32, Z: 0.0 })?;
        self.clip.SetSize(Vector2 { X: (clip.width * s) as f32, Y: (clip.height * s) as f32 })?;
        self.shade.SetSize(Vector2 { X: (clip.width * s) as f32, Y: (clip.height * s) as f32 })?;
        self.web.SetOffset(Vector3 { X: (offset.0 * s) as f32, Y: (offset.1 * s) as f32, Z: 0.0 })?;
        let base: ICoreWebView2Controller = self.controller.cast()?;
        let bounds = RECT { left: 0, top: 0, right: (logical.0 * s).round() as i32, bottom: (logical.1 * s).round() as i32 };
        unsafe {
            base.SetBounds(bounds)?;
            base.SetIsVisible(visible)?;
        }
        self.clip.SetIsVisible(visible && clip.width > 0.0 && clip.height > 0.0)?;
        self.placed = Some((clip, radius, rounded_clips, layer));
        self.apply_mask(occlusions)
    }

    /// `occlusion` (every document) and `place`: rebuild the geometric clip and the shade.
    pub fn apply_mask(&mut self, occlusions: &[Occlusion]) -> Result<()> {
        let Some((clip, radius, rounded, layer)) = &self.placed else { return Ok(()) };
        self.mask = Mask::build(*clip, *radius, rounded, occlusions, *layer);
        let s = self.scale;
        let Some(base) = self.mask.base else { return Ok(()) };
        let mut geometry: ID2D1Geometry = rounded_path(&self.d2d, base, s)?.cast()?;
        for shape in &self.mask.intersect {
            geometry = combine(&self.d2d, &geometry, &rounded_path(&self.d2d, *shape, s)?.cast()?, D2D1_COMBINE_MODE_INTERSECT)?;
        }
        for hole in &self.mask.subtract {
            geometry = combine(&self.d2d, &geometry, &rounded_path(&self.d2d, *hole, s)?.cast()?, D2D1_COMBINE_MODE_EXCLUDE)?;
        }
        let source: IGeometrySource2D = GeometrySource(geometry).into();
        let path = CompositionPath::Create(&source)?;
        let geometry = self.compositor.CreatePathGeometryWithPath(&path)?;
        self.clip.SetClip(&self.compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
        let alpha = (self.mask.dim.clamp(0.0, 1.0) * 255.0).round() as u8;
        self.shade.SetBrush(&self.compositor.CreateColorBrushWithColor(Color { A: alpha, R: 0, G: 0, B: 0 })?)?;
        Ok(())
    }

    /// `present`: opacity and scale about `origin` (fractions of the clip box) on the compositor's clock, with the
    /// same cubic-bezier curve as Core Animation. `from` starts an entrance; otherwise the animation starts from the
    /// value on screen (a keyframe animation without a 0.0 key starts from the current value).
    pub fn present(&self, opacity: f32, scale: f32, from: (Option<f32>, Option<f32>), seconds: f64, ease: [f32; 4], origin: (f32, f32)) -> Result<()> {
        let size = self.clip.Size()?;
        self.clip.SetCenterPoint(Vector3 { X: size.X * origin.0, Y: size.Y * origin.1, Z: 0.0 })?;
        if seconds <= 0.0 {
            self.clip.StopAnimation(&HSTRING::from("Opacity"))?;
            self.clip.StopAnimation(&HSTRING::from("Scale"))?;
            self.clip.SetOpacity(opacity)?;
            return self.clip.SetScale(Vector3 { X: scale, Y: scale, Z: 1.0 });
        }
        let curve = self.compositor.CreateCubicBezierEasingFunction(Vector2 { X: ease[0], Y: ease[1] }, Vector2 { X: ease[2], Y: ease[3] })?;
        let duration = TimeSpan { Duration: (seconds * 10_000_000.0) as i64 };
        let fade = self.compositor.CreateScalarKeyFrameAnimation()?;
        if let Some(start) = from.0 {
            fade.InsertKeyFrame(0.0, start)?;
        }
        fade.InsertKeyFrameWithEasingFunction(1.0, opacity, &curve)?;
        fade.SetDuration(duration)?;
        let grow = self.compositor.CreateVector3KeyFrameAnimation()?;
        if let Some(start) = from.1 {
            grow.InsertKeyFrame(0.0, Vector3 { X: start, Y: start, Z: 1.0 })?;
        }
        grow.InsertKeyFrameWithEasingFunction(1.0, Vector3 { X: scale, Y: scale, Z: 1.0 }, &curve)?;
        grow.SetDuration(duration)?;
        self.clip.StartAnimation(&HSTRING::from("Opacity"), &fade)?;
        self.clip.StartAnimation(&HSTRING::from("Scale"), &grow)
    }

    /// The pointer filter, called from GPUI's window procedure (fork hook) with the message and the pointer in window
    /// points. Returns true when the document took it (GPUI must not see it). The caller tracks capture across a drag
    /// (`SetCapture` while a button is down inside), `outsidePress` for live visuals, and `pointerCaptured`.
    pub fn forward_mouse(&self, message: u32, wparam: usize, x: f64, y: f64) -> Result<bool> {
        let Some((clip, ..)) = &self.placed else { return Ok(false) };
        let (lx, ly) = (x - clip.x, y - clip.y);
        if message != WM_MOUSELEAVE && !self.mask.hit(lx, ly) {
            return Ok(false);
        }
        let kind = match message {
            WM_MOUSEMOVE => COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
            WM_LBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
            WM_LBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
            WM_RBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
            WM_RBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
            WM_MBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
            WM_MBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
            WM_XBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
            WM_XBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
            WM_MOUSEWHEEL => COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
            WM_MOUSEHWHEEL => COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
            WM_MOUSELEAVE => COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
            _ => return Ok(false),
        };
        let keys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS((wparam & 0xFFFF) as i32);
        // Wheel delta / X button are the high word of wParam.
        let data = if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_XBUTTONDOWN | WM_XBUTTONUP) { (wparam >> 16) as u16 as i16 as i32 as u32 } else { 0 };
        let s = self.scale;
        let offset = self.web.Offset()?;
        let point = POINT { x: (lx * s - offset.X as f64).round() as i32, y: (ly * s - offset.Y as f64).round() as i32 };
        unsafe { self.controller.SendMouseInput(kind, keys, data, point)? };
        if message == WM_LBUTTONDOWN {
            // A press gives the document the keyboard (macOS: WKWebView becomes first responder on click).
            let base: ICoreWebView2Controller = self.controller.cast()?;
            unsafe { base.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)? };
        }
        Ok(true)
    }

    /// `snapshotRect` / `snapshot`: CDP draws a fresh frame of the given CSS-pixel rect at `scale` as a PNG (base64 in
    /// the JSON result), with a transparent default background for visuals. `snapshot` is the whole viewport.
    pub fn capture(&self, rect: (f64, f64, f64, f64), scale: f64, done: impl FnOnce(Result<String>) + 'static) -> Result<()> {
        let transparent = self.category == "visual";
        let webview = self.webview.clone();
        let params = format!(
            r#"{{"format":"png","fromSurface":true,"captureBeyondViewport":false,"clip":{{"x":{},"y":{},"width":{},"height":{},"scale":{scale}}}}}"#,
            rect.0, rect.1, rect.2, rect.3
        );
        let shoot = move || -> Result<()> {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                done(result.map(|_| json));
                Ok(())
            }));
            unsafe { webview.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureScreenshot"), &HSTRING::from(params), &handler) }
        };
        if !transparent {
            return shoot();
        }
        let first = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| shoot()));
        unsafe {
            self.webview.CallDevToolsProtocolMethod(
                &HSTRING::from("Emulation.setDefaultBackgroundColorOverride"),
                &HSTRING::from(r#"{"color":{"r":0,"g":0,"b":0,"a":0}}"#),
                &first,
            )
        }
    }

    /// `frame` (picker) and the `kybernFrame` handler: an isolated world in the child frame plus a binding that exists
    /// only in contexts named `KybernPreview` (macOS: `WKContentWorld` "KybernPreview"). The child is cross-site, so it
    /// is an out-of-process iframe: the calls go to its CDP session (`Target.setAutoAttach` with `flatten`, then
    /// `CallDevToolsProtocolMethodForSession`). Results arrive as `Runtime.bindingCalled` events on that session.
    pub fn isolated_world(&self, session_id: &str, frame_id: &str) -> Result<()> {
        let webview11: ICoreWebView2_11 = self.webview.cast()?;
        let calls = [
            ("Runtime.addBinding", r#"{"name":"kybernFrame","executionContextName":"KybernPreview"}"#.to_owned()),
            ("Page.createIsolatedWorld", format!(r#"{{"frameId":{frame_id:?},"worldName":"KybernPreview","grantUniveralAccess":false}}"#)),
        ];
        for (method, params) in calls {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            unsafe {
                webview11.CallDevToolsProtocolMethodForSession(&HSTRING::from(session_id), &HSTRING::from(method), &HSTRING::from(params), &handler)?
            };
        }
        Ok(())
    }

    /// `hide` with no owner for a while: let the browser drop its tiles and suspend timers (macOS has no equivalent;
    /// `setAllMediaPlaybackSuspended` is the nearest). Requires `IsVisible == false`.
    pub fn suspend(&self) -> Result<()> {
        let webview3: ICoreWebView2_3 = self.webview.cast()?;
        let handler = webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
        unsafe { webview3.TrySuspend(&handler) }
    }

    pub fn destroy(self) -> Result<()> {
        let base: ICoreWebView2Controller = self.controller.cast()?;
        unsafe { base.Close()? };
        if let Ok(parent) = self.clip.Parent() {
            parent.Children()?.Remove(&self.clip)?;
        }
        Ok(())
    }
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.contains('@') {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix(if scheme == "http" { ":80" } else { ":443" }).unwrap_or(&host);
    Some(format!("{scheme}://{host}"))
}

/// A rounded rectangle with per-corner radii as a Direct2D path, in device pixels.
fn rounded_path(factory: &ID2D1Factory, r: RoundedRect, s: f64) -> Result<ID2D1PathGeometry> {
    let path = unsafe { factory.CreatePathGeometry()? };
    let sink = unsafe { path.Open()? };
    let (x, y, w, h) = ((r.x * s) as f32, (r.y * s) as f32, (r.width * s) as f32, (r.height * s) as f32);
    let [tl, tr, br, bl] = r.radii.map(|v| (v * s) as f32);
    let p = |x: f32, y: f32| Vector2 { X: x, Y: y };
    let arc = |to: Vector2, radius: f32| D2D1_ARC_SEGMENT {
        point: to,
        size: D2D_SIZE_F { width: radius, height: radius },
        rotationAngle: 0.0,
        sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
        arcSize: D2D1_ARC_SIZE_SMALL,
    };
    unsafe {
        sink.BeginFigure(p(x + tl, y), D2D1_FIGURE_BEGIN_FILLED);
        sink.AddLine(p(x + w - tr, y));
        sink.AddArc(&arc(p(x + w, y + tr), tr));
        sink.AddLine(p(x + w, y + h - br));
        sink.AddArc(&arc(p(x + w - br, y + h), br));
        sink.AddLine(p(x + bl, y + h));
        sink.AddArc(&arc(p(x, y + h - bl), bl));
        sink.AddLine(p(x, y + tl));
        sink.AddArc(&arc(p(x + tl, y), tl));
        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
        sink.Close()?;
    }
    Ok(path)
}

fn combine(factory: &ID2D1Factory, a: &ID2D1Geometry, b: &ID2D1Geometry, mode: D2D1_COMBINE_MODE) -> Result<ID2D1Geometry> {
    let out = unsafe { factory.CreatePathGeometry()? };
    let sink = unsafe { out.Open()? };
    unsafe {
        a.CombineWithGeometry(b, mode, None, 0.25, &sink)?;
        sink.Close()?;
    }
    out.cast()
}

/// `CompositionPath` takes an `IGeometrySource2D`; Direct2D geometry reaches it through `IGeometrySource2DInterop`.
#[implement(IGeometrySource2D, IGeometrySource2DInterop)]
struct GeometrySource(ID2D1Geometry);

impl windows::Graphics::IGeometrySource2D_Impl for GeometrySource_Impl {}

impl IGeometrySource2DInterop_Impl for GeometrySource_Impl {
    fn GetGeometry(&self) -> Result<ID2D1Geometry> {
        Ok(self.0.clone())
    }
    fn TryGetGeometryUsingFactory(&self, _factory: windows::core::Ref<'_, windows::Win32::Graphics::Direct2D::ID2D1Factory>) -> Result<ID2D1Geometry> {
        Ok(self.0.clone())
    }
}

#[allow(dead_code)]
fn _unused(_: BOOL) {}
