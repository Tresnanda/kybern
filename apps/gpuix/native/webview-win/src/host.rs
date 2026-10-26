//! WebView2 documents hosted in Windows.UI.Composition over GPUI's DirectComposition swap chain: the Windows port of
//! `native/webview.m`, op for op. apps/gpuix/WEBVIEW-PLATFORMS.md has the design and the parity matrix.
//!
//! Tree per GPUI window (everything on GPUI's UI thread, which owns the HWND and pumps its messages):
//!
//! ```text
//! DComp target, not topmost (gpui_windows, fork commit)   └─ GPUI swap chain
//! WinComp DesktopWindowTarget, topmost (here)             └─ root ContainerVisual
//!                                                              └─ per document: clip ContainerVisual
//!                                                                   (offset/size, CompositionGeometricClip, Opacity, Scale)
//!                                                                   ├─ web ContainerVisual   ← WebView2 RootVisualTarget
//!                                                                   └─ shade SpriteVisual    ← black, occlusion `dim`
//! ```
//!
//! Getting onto the UI thread: Bun's thread queues the command and posts a registered message to a GPUI window; a
//! `WH_GETMESSAGE` hook on the UI thread takes it out of the queue before dispatch and runs the commands there (macOS:
//! `dispatch_async` to the main queue). The first command for a window subclasses it, which is the pointer filter
//! (macOS: `hitTest:` and the `NSEvent` monitors): presses, moves and the wheel over a document go to WebView2 with
//! `SendMouseInput` and never reach GPUI; `WM_SETCURSOR` there shows the page's cursor.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value, json};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler, CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, CursorChangedEventHandler, DownloadStartingEventHandler, ExecuteScriptCompletedHandler,
    FocusChangedEventHandler, FrameCreatedEventHandler, FrameDestroyedEventHandler, FrameNavigationCompletedEventHandler,
    FrameWebMessageReceivedEventHandler, LaunchingExternalUriSchemeEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::IGeometrySource2D;
use windows::UI::Color;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionBatchTypes, CompositionPath, Compositor, ContainerVisual, SpriteVisual};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::{D2D_SIZE_F, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED};
use windows::Win32::Graphics::Direct2D::{
    D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_SMALL, D2D1_COMBINE_MODE, D2D1_COMBINE_MODE_EXCLUDE, D2D1_COMBINE_MODE_INTERSECT,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1CreateFactory, ID2D1Factory, ID2D1Geometry, ID2D1PathGeometry,
};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::Graphics::Direct2D::{IGeometrySource2DInterop, IGeometrySource2DInterop_Impl};
use windows::Win32::System::WinRT::{CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions};
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, GetKeyState, ReleaseCapture, SetCapture, SetFocus, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent, VK_CONTROL,
    VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, HSTRING, Interface, PWSTR, Result, implement};
use windows_numerics::{Vector2, Vector3};

use crate::emit;
use crate::mask::{Mask, Occlusion, RoundedRect};
use crate::policy::{WRAPPER_PREFIX, base64_decode, frame_allows, js_string, origin_of, png_size, snapshot_path_allowed, wrapper_url};

/// Run in every document at creation. In the wrapper (top level, served by us): `webview.ts` `webDocument` and the
/// Mermaid renderer post with `window.webkit.messageHandlers.kybern.postMessage`, the WKWebView API, so it is mapped onto
/// `chrome.webview.postMessage`; and an Escape the page left alone (no `preventDefault`) gives the keyboard back, which
/// WebKit does through `cancelOperation:` (WebView2 has no unhandled-key signal; a page can fake this, which only gives
/// focus back). In the wrapper's child frame: [`FRAME_SCRIPT`].
const DOCUMENT_SCRIPT: &str = concat!(
    "(()=>{const top=window===window.top;",
    "if(top&&location.href.startsWith('http://tauri.localhost/embedded/')){",
    "const post=m=>window.chrome.webview.postMessage(m);",
    "Object.defineProperty(window,'webkit',{value:Object.freeze({messageHandlers:Object.freeze({kybern:Object.freeze({postMessage:post})})})});",
    "addEventListener('keydown',e=>{if(e.key==='Escape')setTimeout(()=>{if(!e.defaultPrevented)post({kybernHost:'escape'})})},true)",
    "}else if(!top&&window.parent===window.top){",
    include_str!("frame.js"),
    "}})()"
);
/// The child frame's half (macOS: the `kybernFrame` handler and user script in the `KybernPreview` world). WebView2 has
/// no content worlds, so this runs in the page's own world: `navigation` on load, `popstate` and `hashchange`; picker
/// messages (`src/pick/pickerScript.ts` posts through `webkit.messageHandlers.kybernFrame`); the unhandled Escape.
/// Messages reach the host only through the frame's own `WebMessageReceived` (`ICoreWebView2Frame2`), with the frame's
/// URL as their source. A page can post them too; the picker's data is untrusted on every OS and re-bounded by the app.
const FRAME_SCRIPT: &str = include_str!("frame.js");

/// The ⌘ key list of `webview.m`'s key monitor, with Ctrl (the primary modifier off macOS): re-emitted as `shortcut`
/// while a page has the keyboard. `p` only with Alt.
const SHORTCUT_KEYS: &[(u32, &str)] = &[
    (0x4C, "l"),
    (0x52, "r"),
    (0x4E, "n"),
    (0x42, "b"),
    (0x4B, "k"),
    (0x4A, "j"),
    (0xDB, "["),
    (0xDD, "]"),
    (0x26, "up"),
    (0xBC, ","),
    (0xDC, "\\"),
    (0x50, "p"),
];

// ---- Bun's thread → the UI thread ----

static PENDING: Mutex<VecDeque<Map<String, Value>>> = Mutex::new(VecDeque::new());
/// The GPUI window to wake (any of them: all share the UI thread).
static TARGET: AtomicIsize = AtomicIsize::new(0);
static WAKE_POSTED: AtomicBool = AtomicBool::new(false);
static HOOKED_THREADS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn wake_message() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(windows::core::w!("KybernWebViewWake")) })
}

fn is_gpui_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid != unsafe { GetCurrentProcessId() } {
        return false;
    }
    let mut class = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
    String::from_utf16_lossy(&class[..length]) == "Zed::Window"
}

/// GPUI's windows in this process, visible ones first.
fn gpui_windows() -> Vec<HWND> {
    unsafe extern "system" fn each(hwnd: HWND, list: LPARAM) -> BOOL {
        if is_gpui_window(hwnd) {
            unsafe { (*(list.0 as *mut Vec<HWND>)).push(hwnd) };
        }
        BOOL(1)
    }
    let mut list: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
    }
    list.sort_by_key(|hwnd| !unsafe { IsWindowVisible(*hwnd) }.as_bool());
    list
}

fn wake_target() -> Option<HWND> {
    let cached = HWND(TARGET.load(Ordering::Acquire) as *mut _);
    if !cached.is_invalid() && unsafe { IsWindow(Some(cached)) }.as_bool() {
        return Some(cached);
    }
    let found = gpui_windows().into_iter().next()?;
    TARGET.store(found.0 as isize, Ordering::Release);
    Some(found)
}

/// `kybern_web_command`, on Bun's thread.
pub fn command(command: Map<String, Value>) {
    let Some(hwnd) = wake_target() else {
        // macOS fails `create` when no window can take it; the rest waits for a window.
        if command.get("op").and_then(Value::as_str) == Some("create") {
            emit(json!({"id": command.get("id"), "type": "failed", "message": "The preview window is unavailable."}));
        } else if let Ok(mut pending) = PENDING.lock() {
            pending.push_back(command);
        }
        return;
    };
    if let Ok(mut pending) = PENDING.lock() {
        pending.push_back(command);
    }
    let thread = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if let Ok(mut hooked) = HOOKED_THREADS.lock()
        && !hooked.contains(&thread)
    {
        // A thread hook in this process needs no module handle.
        if unsafe { SetWindowsHookExW(WH_GETMESSAGE, Some(get_message), None, thread) }.is_ok() {
            hooked.push(thread);
        }
    }
    if !WAKE_POSTED.swap(true, Ordering::AcqRel) {
        unsafe {
            if PostMessageW(Some(hwnd), wake_message(), WPARAM(0), LPARAM(0)).is_err() {
                WAKE_POSTED.store(false, Ordering::Release);
            }
        }
    }
}

/// On the UI thread, as GPUI's loop takes a message off its queue.
unsafe extern "system" fn get_message(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 == PM_REMOVE.0 as usize && lparam.0 != 0 {
        let message = unsafe { &mut *(lparam.0 as *mut MSG) };
        if message.message == wake_message() {
            // GPUI's window procedure sees WM_NULL instead.
            message.message = WM_NULL;
            drain();
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn drain() {
    WAKE_POSTED.store(false, Ordering::Release);
    loop {
        let next = PENDING.lock().ok().and_then(|mut pending| pending.pop_front());
        let Some(command) = next else { break };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| with_host(move |host| host.handle(command))));
        if result.is_err() {
            eprintln!("[kybern-webview] a command panicked");
        }
    }
}

type Deferred = Box<dyn FnOnce(&mut Host)>;

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
    /// Work that arrived while the host was busy (a WebView2 or window callback re-entering a host call); the borrower
    /// runs it before letting go.
    static DEFERRED: RefCell<VecDeque<Deferred>> = RefCell::new(VecDeque::new());
    /// Each subclassed window's original procedure, read without borrowing the host.
    static PROCS: RefCell<HashMap<isize, isize>> = RefCell::new(HashMap::new());
}

fn with_host(work: impl FnOnce(&mut Host) + 'static) {
    HOST.with(|cell| match cell.try_borrow_mut() {
        Ok(mut slot) => {
            let host = slot.get_or_insert_with(Host::new);
            work(host);
            while let Some(next) = DEFERRED.with(|d| d.borrow_mut().pop_front()) {
                next(host);
            }
        }
        Err(_) => DEFERRED.with(|d| d.borrow_mut().push_back(Box::new(work))),
    });
}

/// The host now, or `None` when it is busy further up this thread's stack.
fn try_host<R>(work: impl FnOnce(&mut Host) -> R) -> Option<R> {
    HOST.with(|cell| {
        let mut slot = cell.try_borrow_mut().ok()?;
        Some(work(slot.get_or_insert_with(Host::new)))
    })
}

pub fn runtime_version() -> Option<String> {
    let mut version = PWSTR::null();
    unsafe { GetAvailableCoreWebView2BrowserVersionString(None, &mut version) }.ok()?;
    let version = webview2_com::take_pwstr(version);
    (!version.is_empty()).then_some(version)
}

// ---- the window procedure filter ----

unsafe extern "system" fn subclass(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let original = PROCS.with(|procs| procs.borrow().get(&(hwnd.0 as isize)).copied()).unwrap_or(0);
    let call = |message: u32, wparam: WPARAM, lparam: LPARAM| unsafe {
        let original: WNDPROC = std::mem::transmute(original);
        CallWindowProcW(original, hwnd, message, wparam, lparam)
    };
    match message {
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_RBUTTONDBLCLK
        | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK | WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK | WM_MOUSEWHEEL
        | WM_MOUSEHWHEEL | WM_MOUSELEAVE | WM_SETCURSOR => {
            let routed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                try_host(|host| host.pointer(hwnd, message, wparam, lparam)).flatten()
            }));
            match routed {
                Ok(Some(Pointer::Swallow(result))) => return result,
                Ok(Some(Pointer::LeaveGpui)) => {
                    // The pointer moved from GPUI onto a page: GPUI clears its hover as if it left the window.
                    call(WM_MOUSELEAVE, WPARAM(0), LPARAM(0));
                    return LRESULT(0);
                }
                _ => {}
            }
        }
        WM_SIZE | WM_SHOWWINDOW | WM_DPICHANGED | WM_WINDOWPOSCHANGED => {
            let result = call(message, wparam, lparam);
            with_host(move |host| host.window_changed(hwnd));
            return result;
        }
        WM_NCDESTROY => {
            with_host(move |host| host.window_destroyed(hwnd));
            unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, original) };
            PROCS.with(|procs| procs.borrow_mut().remove(&(hwnd.0 as isize)));
            return call(message, wparam, lparam);
        }
        _ => {}
    }
    call(message, wparam, lparam)
}

enum Pointer {
    /// A page took the event; GPUI must not see it.
    Swallow(LRESULT),
    /// As `Swallow`, after GPUI is told the pointer left it.
    LeaveGpui,
}

// ---- the host ----

struct Window {
    _target: DesktopWindowTarget,
    root: ContainerVisual,
}

enum Environment {
    Idle,
    Starting,
    Ready(ICoreWebView2Environment),
    Failed(String),
}

#[derive(Clone)]
struct Placement {
    /// Window points.
    clip: RoundedRect,
    radius: f64,
    rounded: Vec<[f64; 8]>,
    offset: (f64, f64),
    logical: (f64, f64),
}

struct Doc {
    id: String,
    category: String,
    generation: Value,
    allowed: Vec<String>,
    wrapper: String,
    html: String,
    hwnd: HWND,
    clip: ContainerVisual,
    web: ContainerVisual,
    shade: SpriteVisual,
    requested: bool,
    controller: Option<ICoreWebView2CompositionController>,
    webview: Option<ICoreWebView2>,
    /// Scripts and focus sent before the controller existed.
    pending: Vec<String>,
    pending_focus: bool,
    placement: Option<Placement>,
    placed: bool,
    layer: i64,
    mask: Mask,
    mask_scale: f64,
    dim: f64,
    scale: f64,
    bounds: (i32, i32),
    last_visible: Option<bool>,
    focused: bool,
    cursor: isize,
    child: Option<ICoreWebView2Frame2>,
    child_loaded: bool,
    /// `present` targets and whether its animation is still running (`probe`).
    shown: (f32, f32),
    animating: Arc<AtomicU64>,
}

struct Host {
    d2d: Option<ID2D1Factory>,
    compositor: Option<Compositor>,
    _queue: Option<windows::System::DispatcherQueueController>,
    windows: HashMap<isize, Window>,
    /// Creation order, which is the stacking order (macOS: subviews added in turn).
    docs: Vec<Doc>,
    occlusions: BTreeMap<i64, Occlusion>,
    pointer_captured: bool,
    environment: Environment,
    /// The document a button went down in: it gets every pointer event until the last button is up.
    pressed: Option<String>,
    hover: Option<String>,
    last_down: Option<(u32, POINT, String)>,
}

fn num(command: &Map<String, Value>, key: &str) -> f64 {
    command.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn text<'a>(command: &'a Map<String, Value>, key: &str) -> &'a str {
    command.get(key).and_then(Value::as_str).unwrap_or("")
}

fn scale_of(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

fn take(get: impl FnOnce(&mut PWSTR) -> Result<()>) -> String {
    let mut value = PWSTR::null();
    if get(&mut value).is_err() {
        return String::new();
    }
    webview2_com::take_pwstr(value)
}

fn exec(webview: &ICoreWebView2, script: &str, done: impl FnOnce(std::result::Result<String, String>) + 'static) {
    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
        done(result.map(|_| json).map_err(|e| e.message().to_string()));
        Ok(())
    }));
    let _ = unsafe { webview.ExecuteScript(&HSTRING::from(script), &handler) };
}

fn exec_frame(frame: &ICoreWebView2Frame2, script: &str, done: impl FnOnce(std::result::Result<String, String>) + 'static) {
    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
        done(result.map(|_| json).map_err(|e| e.message().to_string()));
        Ok(())
    }));
    let _ = unsafe { frame.ExecuteScript(&HSTRING::from(script), &handler) };
}

fn cdp(webview: &ICoreWebView2, method: &str, params: &str, done: impl FnOnce(std::result::Result<String, String>) + 'static) {
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
        done(result.map(|_| json).map_err(|e| e.message().to_string()));
        Ok(())
    }));
    if let Err(error) = unsafe { webview.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler) } {
        eprintln!("[kybern-webview] {method}: {error:?}");
    }
}

impl Host {
    fn new() -> Self {
        Host {
            d2d: unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) }.ok(),
            compositor: None,
            _queue: None,
            windows: HashMap::new(),
            docs: Vec::new(),
            occlusions: BTreeMap::new(),
            pointer_captured: false,
            environment: Environment::Idle,
            pressed: None,
            hover: None,
            last_down: None,
        }
    }

    fn doc(&mut self, id: &str) -> Option<&mut Doc> {
        self.docs.iter_mut().find(|doc| doc.id == id)
    }

    fn handle(&mut self, command: Map<String, Value>) {
        let op = text(&command, "op").to_owned();
        let id = text(&command, "id").to_owned();
        match op.as_str() {
            "capture" => {
                self.pointer_captured = command.get("active").and_then(Value::as_bool).unwrap_or(false);
                return;
            }
            "release" => {
                for doc in &self.docs {
                    release_focus(doc);
                }
                return;
            }
            "occlusion" => {
                let layer = command.get("layer").and_then(Value::as_i64).unwrap_or(0);
                match command.get("rect").and_then(Value::as_object) {
                    Some(rect) => {
                        let radius = num(&command, "radius");
                        let occlusion = Occlusion {
                            rect: RoundedRect::uniform(num(rect, "x"), num(rect, "y"), num(rect, "width"), num(rect, "height"), radius),
                            order: command.get("order").and_then(Value::as_i64).unwrap_or(layer),
                            dim: num(&command, "dim"),
                            input_only: command.get("inputOnly").and_then(Value::as_bool).unwrap_or(false),
                        };
                        self.occlusions.insert(layer, occlusion);
                    }
                    None => {
                        self.occlusions.remove(&layer);
                    }
                }
                let occlusions: Vec<Occlusion> = self.occlusions.values().copied().collect();
                let d2d = self.d2d.clone();
                let compositor = self.compositor.clone();
                for doc in &mut self.docs {
                    let _ = doc.apply_mask(&occlusions, d2d.as_ref(), compositor.as_ref());
                }
                return;
            }
            "create" => {
                self.create(&id, &command);
                return;
            }
            _ => {}
        }
        if self.doc(&id).is_none() {
            return;
        }
        let occlusions: Vec<Occlusion> = self.occlusions.values().copied().collect();
        let d2d = self.d2d.clone();
        let compositor = self.compositor.clone();
        match op.as_str() {
            "hide" => {
                let doc = self.doc(&id).unwrap();
                doc.placed = false;
                doc.visibility();
            }
            "place" => {
                let doc = self.doc(&id).unwrap();
                let _ = doc.place(&command, &occlusions, d2d.as_ref(), compositor.as_ref());
            }
            "present" => {
                if let (Some(compositor), Some(doc)) = (compositor, self.docs.iter().find(|d| d.id == id)) {
                    let _ = doc.present(&compositor, &command);
                }
                if let Some(doc) = self.doc(&id) {
                    doc.shown = (num(&command, "opacity") as f32, num(&command, "scale") as f32);
                }
            }
            "probe" => {
                let doc = self.doc(&id).unwrap();
                emit(json!({"id": id, "type": "probe", "data": {
                    "opacity": doc.shown.0, "scale": doc.shown.1, "animating": doc.animating.load(Ordering::Acquire) & 1 == 1,
                }}));
            }
            "post" => {
                let script = text(&command, "script").to_owned();
                self.doc(&id).unwrap().run(script);
            }
            "navigate" => {
                let doc = self.doc(&id).unwrap();
                let url = text(&command, "url");
                if origin_of(url).is_none() || !frame_allows(url, &doc.allowed) {
                    return;
                }
                let literal = format!("[{}]", js_string(url));
                match (&doc.child, doc.child_loaded) {
                    (Some(child), true) => exec_frame(
                        child,
                        &format!("{{const url=({literal})[0];if(location.href===url)location.reload();else location.replace(url)}}"),
                        |_| {},
                    ),
                    _ => doc.run(format!("document.querySelector('iframe').src=({literal})[0]")),
                }
            }
            "action" => {
                let doc = self.doc(&id).unwrap();
                let action = text(&command, "action");
                if action == "stop" {
                    if let Some(webview) = &doc.webview {
                        let _ = unsafe { webview.Stop() };
                    }
                    return;
                }
                let script = match action {
                    "back" => "history.back()",
                    "forward" => "history.forward()",
                    "reload" => "location.reload()",
                    _ => return,
                };
                if let (Some(child), true) = (&doc.child, doc.child_loaded) {
                    exec_frame(child, script, |_| {});
                }
            }
            "destroy" => {
                let index = self.docs.iter().position(|d| d.id == id).unwrap();
                let doc = self.docs.remove(index);
                if self.pressed.as_deref() == Some(&id) {
                    self.pressed = None;
                    let _ = unsafe { ReleaseCapture() };
                }
                if self.hover.as_deref() == Some(&id) {
                    self.hover = None;
                }
                let generation = doc.generation.clone();
                doc.dispose();
                emit(json!({"id": id, "generation": generation, "type": "destroyed"}));
            }
            "focus" => {
                let doc = self.doc(&id).unwrap();
                match &doc.controller {
                    Some(controller) => {
                        if let Ok(base) = controller.cast::<ICoreWebView2Controller>() {
                            let _ = unsafe { base.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
                        }
                    }
                    None => doc.pending_focus = true,
                }
            }
            "snapshot" => self.doc(&id).unwrap().snapshot(&command),
            "frame" => self.doc(&id).unwrap().frame(&command),
            "snapshotRect" => self.doc(&id).unwrap().snapshot_rect(&command),
            _ => {}
        }
    }

    fn ensure_compositor(&mut self) -> Option<Compositor> {
        if self.compositor.is_none() {
            // WinComp needs a DispatcherQueue on this thread; it rides on GPUI's message pump.
            if windows::System::DispatcherQueue::GetForCurrentThread().is_err() {
                let options = DispatcherQueueOptions {
                    dwSize: size_of::<DispatcherQueueOptions>() as u32,
                    threadType: DQTYPE_THREAD_CURRENT,
                    apartmentType: DQTAT_COM_NONE,
                };
                self._queue = unsafe { CreateDispatcherQueueController(options) }.ok();
            }
            self.compositor = Compositor::new().ok();
        }
        self.compositor.clone()
    }

    /// The composition target on `hwnd` and the pointer filter, once per window.
    fn ensure_window(&mut self, hwnd: HWND) -> std::result::Result<ContainerVisual, String> {
        if let Some(window) = self.windows.get(&(hwnd.0 as isize)) {
            return Ok(window.root.clone());
        }
        let compositor = self.ensure_compositor().ok_or("Windows composition is unavailable.")?;
        let interop: ICompositorDesktopInterop = compositor.cast().map_err(|e| e.message().to_string())?;
        // Topmost, above GPUI's DirectComposition target. An unpatched GPUI keeps its own target topmost and this fails
        // with DCOMPOSITION_ERROR_WINDOW_ALREADY_COMPOSED.
        let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, true) }
            .map_err(|e| format!("This Kybern build can't show web pages in its window ({}). Update Kybern.", e.message()))?;
        let root = compositor.CreateContainerVisual().map_err(|e| e.message().to_string())?;
        target.SetRoot(&root).map_err(|e| e.message().to_string())?;
        let key = hwnd.0 as isize;
        if !PROCS.with(|procs| procs.borrow().contains_key(&key)) {
            let original = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass as *const () as isize) };
            PROCS.with(|procs| procs.borrow_mut().insert(key, original));
        }
        self.windows.insert(key, Window { _target: target, root: root.clone() });
        Ok(root)
    }

    fn create(&mut self, id: &str, command: &Map<String, Value>) {
        let category = text(command, "category").to_owned();
        let generation = command.get("generation").cloned().unwrap_or(Value::Null);
        let previews = self.docs.iter().filter(|d| d.category == "preview").count();
        if self.doc(id).is_some() || (category == "preview" && previews >= 2) {
            emit(json!({"id": id, "type": "failed", "message": "Close another preview and try again."}));
            return;
        }
        // The window in front if it is GPUI's, else the first visible one (macOS: the first window that can be key).
        let foreground = unsafe { GetForegroundWindow() };
        let current = unsafe { GetCurrentThreadId() };
        let windows: Vec<HWND> = gpui_windows().into_iter().filter(|w| unsafe { GetWindowThreadProcessId(*w, None) } == current).collect();
        let Some(hwnd) = windows.iter().copied().find(|w| *w == foreground).or_else(|| windows.first().copied()) else {
            emit(json!({"id": id, "type": "failed", "message": "The preview window is unavailable."}));
            return;
        };
        let root = match self.ensure_window(hwnd) {
            Ok(root) => root,
            Err(message) => {
                emit(json!({"id": id, "type": "failed", "message": message}));
                return;
            }
        };
        let compositor = self.compositor.clone().unwrap();
        let visuals = (|| -> Result<(ContainerVisual, ContainerVisual, SpriteVisual)> {
            let clip = compositor.CreateContainerVisual()?;
            let web = compositor.CreateContainerVisual()?;
            let shade = compositor.CreateSpriteVisual()?;
            shade.SetBrush(&compositor.CreateColorBrushWithColor(Color { A: 0, R: 0, G: 0, B: 0 })?)?;
            clip.Children()?.InsertAtTop(&web)?;
            clip.Children()?.InsertAtTop(&shade)?;
            clip.SetIsVisible(false)?;
            root.Children()?.InsertAtTop(&clip)?;
            Ok((clip, web, shade))
        })();
        let Ok((clip, web, shade)) = visuals else {
            emit(json!({"id": id, "type": "failed", "message": "The page could not be shown."}));
            return;
        };
        let allowed = command
            .get("allowedOrigins")
            .and_then(Value::as_array)
            .map(|origins| origins.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        self.docs.push(Doc {
            id: id.to_owned(),
            category,
            generation: generation.clone(),
            allowed,
            wrapper: wrapper_url(id),
            html: text(command, "html").to_owned(),
            hwnd,
            clip,
            web,
            shade,
            requested: false,
            controller: None,
            webview: None,
            pending: Vec::new(),
            pending_focus: false,
            placement: None,
            placed: false,
            layer: 0,
            mask: Mask::default(),
            mask_scale: 0.0,
            dim: 0.0,
            scale: scale_of(hwnd),
            bounds: (0, 0),
            last_visible: None,
            focused: false,
            cursor: 0,
            child: None,
            child_loaded: false,
            shown: (1.0, 1.0),
            animating: Arc::new(AtomicU64::new(0)),
        });
        emit(json!({"id": id, "generation": generation, "type": "created", "windowNumber": hwnd.0 as isize}));
        self.start_controllers();
    }

    /// Ask for a controller for every document that has none, creating the environment first.
    fn start_controllers(&mut self) {
        match &self.environment {
            Environment::Ready(environment) => {
                let environment = environment.clone();
                for doc in self.docs.iter_mut().filter(|d| !d.requested) {
                    doc.requested = true;
                    if let Err(error) = request_controller(&environment, doc) {
                        emit(
                            json!({"id": doc.id, "generation": doc.generation, "type": "failed", "message": format!("The page could not open ({}).", error.message())}),
                        );
                    }
                }
            }
            Environment::Starting => {}
            Environment::Failed(message) => {
                for doc in self.docs.iter_mut().filter(|d| !d.requested) {
                    doc.requested = true;
                    emit(json!({"id": doc.id, "generation": doc.generation, "type": "failed", "message": message}));
                }
            }
            Environment::Idle => {
                self.environment = Environment::Starting;
                if let Err(error) = start_environment() {
                    self.environment = Environment::Failed(environment_failure(&error.message()));
                    self.start_controllers();
                }
            }
        }
    }

    fn environment_ready(&mut self, result: Result<()>, environment: Option<ICoreWebView2Environment>) {
        self.environment = match (result, environment) {
            (Ok(()), Some(environment)) => Environment::Ready(environment),
            (Err(error), _) => Environment::Failed(environment_failure(&error.message())),
            (Ok(()), None) => Environment::Failed(environment_failure("no environment")),
        };
        self.start_controllers();
    }

    fn controller_ready(
        &mut self,
        id: &str,
        generation: &Value,
        result: Result<()>,
        controller: Option<ICoreWebView2CompositionController>,
    ) {
        let environment = self.environment_handle();
        let Some(doc) = self.docs.iter_mut().find(|d| d.id == id && d.generation == *generation) else {
            // Destroyed while WebView2 was starting.
            if let Some(controller) = controller.and_then(|c| c.cast::<ICoreWebView2Controller>().ok()) {
                let _ = unsafe { controller.Close() };
            }
            return;
        };
        let controller = match (result, controller) {
            (Ok(()), Some(controller)) => controller,
            (result, _) => {
                let message = result.err().map(|e| e.message().to_string()).unwrap_or_default();
                emit(
                    json!({"id": id, "generation": generation, "type": "failed", "message": format!("The page could not open ({message}).")}),
                );
                return;
            }
        };
        if let Err(error) = doc.attach(controller, environment) {
            emit(
                json!({"id": id, "generation": generation, "type": "failed", "message": format!("The page could not open ({}).", error.message())}),
            );
            return;
        }
        let occlusions: Vec<Occlusion> = self.occlusions.values().copied().collect();
        let d2d = self.d2d.clone();
        let compositor = self.compositor.clone();
        let doc = self.docs.iter_mut().find(|d| d.id == id).unwrap();
        let _ = doc.apply_mask(&occlusions, d2d.as_ref(), compositor.as_ref());
        doc.visibility();
    }

    fn environment_handle(&self) -> Option<ICoreWebView2Environment> {
        match &self.environment {
            Environment::Ready(environment) => Some(environment.clone()),
            _ => None,
        }
    }

    /// Minimize, restore, show, hide, a DPI change: recompute what each document in the window shows.
    fn window_changed(&mut self, hwnd: HWND) {
        let scale = scale_of(hwnd);
        for doc in self.docs.iter_mut().filter(|d| d.hwnd == hwnd) {
            if (doc.scale - scale).abs() > f64::EPSILON {
                doc.scale = scale;
                if let Some(controller) = doc.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller3>().ok()) {
                    let _ = unsafe { controller.SetRasterizationScale(scale) };
                }
            }
            doc.visibility();
        }
    }

    fn window_destroyed(&mut self, hwnd: HWND) {
        let (gone, kept): (Vec<Doc>, Vec<Doc>) = std::mem::take(&mut self.docs).into_iter().partition(|d| d.hwnd == hwnd);
        self.docs = kept;
        for doc in gone {
            let (id, generation) = (doc.id.clone(), doc.generation.clone());
            doc.dispose();
            emit(json!({"id": id, "generation": generation, "type": "destroyed"}));
        }
        self.windows.remove(&(hwnd.0 as isize));
        if TARGET.load(Ordering::Acquire) == hwnd.0 as isize {
            TARGET.store(0, Ordering::Release);
        }
    }

    /// The pointer filter. `None` lets GPUI have the event.
    fn pointer(&mut self, hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<Pointer> {
        if !self.docs.iter().any(|d| d.hwnd == hwnd && d.placed) {
            return None;
        }
        let scale = scale_of(hwnd);
        let mut point = POINT { x: (lparam.0 & 0xFFFF) as u16 as i16 as i32, y: ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32 };
        if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
            let _ = unsafe { ScreenToClient(hwnd, &mut point) };
        }
        if message == WM_SETCURSOR || message == WM_MOUSELEAVE {
            let _ = unsafe { GetCursorPos(&mut point) };
            let _ = unsafe { ScreenToClient(hwnd, &mut point) };
        }
        let (x, y) = (point.x as f64 / scale, point.y as f64 / scale);
        let hit = if self.pointer_captured {
            None
        } else {
            self.docs.iter().rev().find(|d| d.hwnd == hwnd && d.hits(x, y)).map(|d| d.id.clone())
        };
        match message {
            WM_SETCURSOR => {
                let over = self.pressed.clone().or(hit)?;
                if (lparam.0 & 0xFFFF) as u32 != HTCLIENT {
                    return None;
                }
                let doc = self.docs.iter().find(|d| d.id == over)?;
                if doc.cursor == 0 {
                    return None;
                }
                unsafe { SetCursor(Some(HCURSOR(doc.cursor as *mut _))) };
                return Some(Pointer::Swallow(LRESULT(1)));
            }
            WM_MOUSELEAVE => {
                if let Some(previous) = self.hover.take()
                    && let Some(doc) = self.docs.iter().find(|d| d.id == previous)
                {
                    doc.send_mouse(COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE, 0, 0, (0.0, 0.0));
                }
                return None;
            }
            _ => {}
        }
        let keys = (wparam.0 & 0xFFFF) as i32;
        let data = if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) {
            ((wparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32 as u32
        } else {
            0
        };
        let down = matches!(
            message,
            WM_LBUTTONDOWN
                | WM_RBUTTONDOWN
                | WM_MBUTTONDOWN
                | WM_XBUTTONDOWN
                | WM_LBUTTONDBLCLK
                | WM_RBUTTONDBLCLK
                | WM_MBUTTONDBLCLK
                | WM_XBUTTONDBLCLK
        );
        if down {
            // A live visual goes back to its picture on a press anywhere else (window points, top-left origin).
            for doc in self.docs.iter().filter(|d| d.hwnd == hwnd && d.category == "visual" && d.placed) {
                if hit.as_deref() != Some(doc.id.as_str()) {
                    emit(json!({"id": doc.id, "generation": doc.generation, "type": "outsidePress", "x": x, "y": y}));
                }
            }
            if hit.is_none() {
                // A press on GPUI (or a popup cut out of a page) takes the keyboard back.
                for doc in self.docs.iter().filter(|d| d.hwnd == hwnd) {
                    release_focus(doc);
                }
                return None;
            }
        }
        let target = self.pressed.clone().or_else(|| hit.clone());
        // Hover moves between documents and GPUI.
        let mut leave_gpui = false;
        if message == WM_MOUSEMOVE && self.hover != hit {
            if let Some(previous) = self.hover.take() {
                if let Some(doc) = self.docs.iter().find(|d| d.id == previous) {
                    doc.send_mouse(COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE, 0, 0, (0.0, 0.0));
                }
            } else if hit.is_some() {
                leave_gpui = true;
            }
            self.hover = hit.clone();
            if hit.is_some() {
                let mut track =
                    TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                let _ = unsafe { TrackMouseEvent(&mut track) };
            }
        }
        let target = target?;
        let doc = self.docs.iter().find(|d| d.id == target)?;
        let mut kind = match message {
            WM_MOUSEMOVE => COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
            WM_LBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
            WM_LBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
            WM_LBUTTONDBLCLK => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK,
            WM_RBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
            WM_RBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
            WM_RBUTTONDBLCLK => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK,
            WM_MBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
            WM_MBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
            WM_MBUTTONDBLCLK => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
            WM_XBUTTONDOWN => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
            WM_XBUTTONUP => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
            WM_XBUTTONDBLCLK => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK,
            WM_MOUSEWHEEL => COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
            WM_MOUSEHWHEEL => COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
            _ => return None,
        };
        // GPUI's window class has no CS_DBLCLKS, so a second press in time and place becomes the double click WebView2
        // expects (down, up, double click, up).
        if message == WM_LBUTTONDOWN {
            let time = unsafe { GetMessageTime() } as u32;
            let within = |a: i32, b: i32, metric: SYSTEM_METRICS_INDEX| (a - b).abs() <= unsafe { GetSystemMetrics(metric) } / 2;
            if let Some((then, at, id)) = &self.last_down
                && *id == target
                && time.wrapping_sub(*then) <= unsafe { GetDoubleClickTime() }
                && within(at.x, point.x, SM_CXDOUBLECLK)
                && within(at.y, point.y, SM_CYDOUBLECLK)
            {
                kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK;
            }
            self.last_down =
                if kind == COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK { None } else { Some((time, point, target.clone())) };
        }
        doc.send_mouse(kind, keys, data, (x, y));
        if down {
            // A press gives the page the keyboard (macOS: the WKWebView becomes first responder on click) and keeps the
            // pointer until the last button is up, so drags and selections work outside the page.
            if let Some(controller) = doc.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller>().ok()) {
                let _ = unsafe { controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
            }
            self.pressed = Some(target);
            unsafe { SetCapture(hwnd) };
        } else if matches!(message, WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP) && keys & 0x73 == 0 {
            self.pressed = None;
            let _ = unsafe { ReleaseCapture() };
        }
        Some(if leave_gpui { Pointer::LeaveGpui } else { Pointer::Swallow(LRESULT(0)) })
    }
}

fn release_focus(doc: &Doc) {
    if doc.focused {
        let _ = unsafe { SetFocus(Some(doc.hwnd)) };
    }
}

fn environment_failure(detail: &str) -> String {
    format!("Install the Microsoft Edge WebView2 Runtime, then reopen Kybern ({detail}).")
}

/// One environment per app. The user data folder is `%LOCALAPPDATA%\kybern-gpuix\WebView2` (never the install folder;
/// the uninstaller removes it); every controller is InPrivate, so cookies and storage never persist (macOS:
/// `nonPersistentDataStore`). `KYBERN_GPUIX_WEBVIEW2_DATA` overrides the folder for checks.
fn start_environment() -> Result<()> {
    let folder = std::env::var("KYBERN_GPUIX_WEBVIEW2_DATA").unwrap_or_else(|_| {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
        format!("{base}\\kybern-gpuix\\WebView2")
    });
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
        with_host(move |host| host.environment_ready(result, environment));
        Ok(())
    }));
    unsafe { CreateCoreWebView2EnvironmentWithOptions(None, &HSTRING::from(folder), None, &handler) }
}

fn request_controller(environment: &ICoreWebView2Environment, doc: &Doc) -> Result<()> {
    let environment10: ICoreWebView2Environment10 = environment.cast()?;
    let options = unsafe { environment10.CreateCoreWebView2ControllerOptions()? };
    unsafe { options.SetIsInPrivateModeEnabled(true)? };
    if doc.category == "visual" {
        // Transparent from the first frame (only alpha 0 or 255 is allowed): the thread's material shows through.
        if let Ok(options3) = options.cast::<ICoreWebView2ControllerOptions3>() {
            unsafe { options3.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })? };
        }
    }
    let (id, generation) = (doc.id.clone(), doc.generation.clone());
    let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(move |result, controller| {
        with_host(move |host| host.controller_ready(&id, &generation, result, controller));
        Ok(())
    }));
    unsafe { environment10.CreateCoreWebView2CompositionControllerWithOptions(doc.hwnd, &options, &handler) }
}

impl Doc {
    fn event(&self, kind: &str) -> Map<String, Value> {
        let mut event = Map::new();
        event.insert("id".into(), Value::String(self.id.clone()));
        event.insert("generation".into(), self.generation.clone());
        event.insert("type".into(), Value::String(kind.into()));
        event
    }

    fn hits(&self, x: f64, y: f64) -> bool {
        let Some(placement) = &self.placement else { return false };
        self.placed && self.last_visible == Some(true) && self.mask.hit(x - placement.clip.x, y - placement.clip.y)
    }

    fn send_mouse(&self, kind: COREWEBVIEW2_MOUSE_EVENT_KIND, keys: i32, data: u32, at: (f64, f64)) {
        let (Some(controller), Some(placement)) = (&self.controller, &self.placement) else { return };
        let s = self.scale;
        let point = POINT {
            x: ((at.0 - placement.clip.x - placement.offset.0) * s).round() as i32,
            y: ((at.1 - placement.clip.y - placement.offset.1) * s).round() as i32,
        };
        let _ = unsafe { controller.SendMouseInput(kind, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(keys), data, point) };
    }

    /// `post`, and every script the host sends; queued until the page exists.
    fn run(&mut self, script: String) {
        match &self.webview {
            Some(webview) => exec(webview, &script, |_| {}),
            None => self.pending.push(script),
        }
    }

    /// The controller arrived: configure it like `webview.m`'s `WKWebViewConfiguration` and load the wrapper.
    fn attach(&mut self, controller: ICoreWebView2CompositionController, environment: Option<ICoreWebView2Environment>) -> Result<()> {
        let environment = environment.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
        unsafe { controller.SetRootVisualTarget(&self.web)? };
        let base: ICoreWebView2Controller = controller.cast()?;
        unsafe {
            // Raw pixels: `place` knows the window's scale; GPUI handles WM_DPICHANGED and places again.
            let scaled: ICoreWebView2Controller3 = controller.cast()?;
            scaled.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS)?;
            scaled.SetShouldDetectMonitorScaleChanges(false)?;
            scaled.SetRasterizationScale(self.scale)?;
            if self.category == "visual" {
                let background: ICoreWebView2Controller2 = controller.cast()?;
                background.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
            }
            // A renderer document is never shown; it stays "visible" so its timers are not throttled.
            base.SetIsVisible(self.category == "renderer")?;
        }
        let webview = unsafe { base.CoreWebView2()? };
        unsafe {
            let settings = webview.Settings()?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetIsWebMessageEnabled(true)?;
            settings.SetIsZoomControlEnabled(false)?;
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                // No browser shortcuts (print, find, reload, zoom); WKWebView has none either.
                settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() {
                settings.SetIsPasswordAutosaveEnabled(false)?;
                settings.SetIsGeneralAutofillEnabled(false)?;
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings5>() {
                settings.SetIsPinchZoomEnabled(false)?;
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings6>() {
                settings.SetIsSwipeNavigationEnabled(false)?;
            }
        }
        let mut token = 0i64;
        let (id, generation) = (self.id.clone(), self.generation.clone());
        let event = {
            let (id, generation) = (id.clone(), generation.clone());
            move |kind: &str, fields: Value| {
                let mut event = json!({"id": id, "generation": generation, "type": kind});
                if let (Some(event), Value::Object(fields)) = (event.as_object_mut(), fields) {
                    event.extend(fields);
                }
                emit(event);
            }
        };

        // The wrapper, served by the host alone (macOS: the `tauri` scheme handler): every URL under the prefix is
        // answered here, the wrapper with its HTML and the rest with 404.
        unsafe {
            webview.AddWebResourceRequestedFilter(&HSTRING::from(format!("{WRAPPER_PREFIX}*")), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?
        };
        let (wrapper, html, served_by) = (self.wrapper.clone(), self.html.clone(), environment.clone());
        let serve = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let uri = take(|out| unsafe { args.Request()?.Uri(out) });
            let response = if uri == wrapper {
                let stream: Option<IStream> = unsafe { SHCreateMemStream(Some(html.as_bytes())) };
                unsafe {
                    served_by.CreateWebResourceResponse(
                        stream.as_ref(),
                        200,
                        &HSTRING::from("OK"),
                        &HSTRING::from("Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store"),
                    )?
                }
            } else {
                unsafe { served_by.CreateWebResourceResponse(None, 404, &HSTRING::from("Not Found"), &HSTRING::new())? }
            };
            unsafe { args.SetResponse(&response) }
        }));
        unsafe { webview.add_WebResourceRequested(&serve, &mut token)? };

        // Only the wrapper is top level (redirects arrive as NavigationStarting too); frames stay on the document's
        // origins; no new windows, downloads or external schemes. The child's sandbox and CSP are the daemon's.
        let (wrapper, top) = (self.wrapper.clone(), event.clone());
        let guard_top = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let uri = take(|out| unsafe { args.Uri(out) });
            if uri != wrapper {
                unsafe { args.SetCancel(true)? };
                top("externalNavigation", json!({"url": uri}));
            }
            Ok(())
        }));
        unsafe { webview.add_NavigationStarting(&guard_top, &mut token)? };
        let (allowed, frames) = (self.allowed.clone(), event.clone());
        let guard_frames = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let uri = take(|out| unsafe { args.Uri(out) });
            if !frame_allows(&uri, &allowed) {
                unsafe { args.SetCancel(true)? };
                frames("externalNavigation", json!({"url": uri}));
            }
            Ok(())
        }));
        unsafe { webview.add_FrameNavigationStarting(&guard_frames, &mut token)? };
        let popups_event = event.clone();
        let popups = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let uri = take(|out| unsafe { args.Uri(out) });
            unsafe { args.SetHandled(true)? };
            popups_event("externalNavigation", json!({"url": uri}));
            Ok(())
        }));
        unsafe { webview.add_NewWindowRequested(&popups, &mut token)? };
        let deny = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)? };
            }
            Ok(())
        }));
        unsafe { webview.add_PermissionRequested(&deny, &mut token)? };
        if let Ok(webview4) = webview.cast::<ICoreWebView2_4>() {
            let downloads = DownloadStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    unsafe { args.SetCancel(true)? };
                }
                Ok(())
            }));
            unsafe { webview4.add_DownloadStarting(&downloads, &mut token)? };
            let (id, generation) = (id.clone(), generation.clone());
            let frame_event = event.clone();
            let created = FrameCreatedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let frame = unsafe { args.Frame()? };
                let Ok(frame2) = frame.cast::<ICoreWebView2Frame2>() else { return Ok(()) };
                watch_frame(&frame2, id.clone(), generation.clone(), frame_event.clone())?;
                let (id, generation) = (id.clone(), generation.clone());
                with_host(move |host| {
                    if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                        doc.child = Some(frame2);
                        doc.child_loaded = false;
                    }
                });
                Ok(())
            }));
            unsafe { webview4.add_FrameCreated(&created, &mut token)? };
        }
        if let Ok(webview18) = webview.cast::<ICoreWebView2_18>() {
            let schemes_event = event.clone();
            let schemes = LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let uri = take(|out| unsafe { args.Uri(out) });
                unsafe { args.SetCancel(true)? };
                schemes_event("externalNavigation", json!({"url": uri}));
                Ok(())
            }));
            unsafe { webview18.add_LaunchingExternalUriScheme(&schemes, &mut token)? };
        }

        // macOS: the `kybern` handler, main frame only. WebMessageReceived on the CoreWebView2 fires for the top-level
        // document only, and its source must be the wrapper.
        let (wrapper, message_event) = (self.wrapper.clone(), event.clone());
        let (escape_id, escape_generation) = (id.clone(), generation.clone());
        let bridge = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            if take(|out| unsafe { args.Source(out) }) != wrapper {
                return Ok(());
            }
            let json = take(|out| unsafe { args.WebMessageAsJson(out) });
            if json.len() > 65536 {
                return Ok(());
            }
            let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&json) else { return Ok(()) };
            if data.get("kybernHost").and_then(Value::as_str) == Some("escape") {
                let (id, generation) = (escape_id.clone(), escape_generation.clone());
                with_host(move |host| {
                    if let Some(doc) = host.docs.iter().find(|d| d.id == id && d.generation == generation) {
                        release_focus(doc);
                    }
                });
                return Ok(());
            }
            message_event("message", json!({"data": data}));
            Ok(())
        }));
        unsafe { webview.add_WebMessageReceived(&bridge, &mut token)? };

        let (loaded_id, loaded_generation, loaded_event) = (id.clone(), generation.clone(), event.clone());
        let completed = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut success = BOOL(0);
            unsafe { args.IsSuccess(&mut success)? };
            if success.as_bool() {
                let (id, generation, event) = (loaded_id.clone(), loaded_generation.clone(), loaded_event.clone());
                with_host(move |host| {
                    if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                        doc.last_visible = None;
                        doc.visibility();
                    }
                    event("loaded", json!({}));
                });
            } else {
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                unsafe { args.WebErrorStatus(&mut status)? };
                if status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                    loaded_event("failed", json!({"message": format!("The page could not load (error {}).", status.0)}));
                }
            }
            Ok(())
        }));
        unsafe { webview.add_NavigationCompleted(&completed, &mut token)? };
        let failed_event = event.clone();
        let failed = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            if matches!(
                kind,
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                    | COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            ) {
                failed_event("terminated", json!({}));
            }
            Ok(())
        }));
        unsafe { webview.add_ProcessFailed(&failed, &mut token)? };

        // The page's cursor, shown by the window filter's WM_SETCURSOR.
        let (cursor_id, cursor_generation) = (id.clone(), generation.clone());
        let cursor = CursorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(sender) = sender else { return Ok(()) };
            let mut handle = HCURSOR::default();
            unsafe { sender.Cursor(&mut handle)? };
            let (id, generation, handle) = (cursor_id.clone(), cursor_generation.clone(), handle.0 as isize);
            with_host(move |host| {
                if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                    doc.cursor = handle;
                }
            });
            Ok(())
        }));
        unsafe { controller.add_CursorChanged(&cursor, &mut token)? };
        for focused in [true, false] {
            let (id, generation) = (id.clone(), generation.clone());
            let handler = FocusChangedEventHandler::create(Box::new(move |_, _| {
                let (id, generation) = (id.clone(), generation.clone());
                with_host(move |host| {
                    if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                        doc.focused = focused;
                    }
                });
                Ok(())
            }));
            unsafe { if focused { base.add_GotFocus(&handler, &mut token)? } else { base.add_LostFocus(&handler, &mut token)? } };
        }
        // macOS: the ⌘ key monitor. Ctrl here, the same keys; the page never sees them.
        let shortcut_event = event.clone();
        let shortcuts = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            unsafe { args.KeyEventKind(&mut kind)? };
            let mut key = 0u32;
            unsafe { args.VirtualKey(&mut key)? };
            let held = |vk: u16| unsafe { GetKeyState(vk as i32) } < 0;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || !held(VK_CONTROL.0) {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            unsafe { args.PhysicalKeyStatus(&mut status)? };
            if status.WasKeyDown.as_bool() {
                return Ok(());
            }
            let alt = held(VK_MENU.0);
            let Some((_, name)) = SHORTCUT_KEYS.iter().find(|(vk, _)| *vk == key) else { return Ok(()) };
            if alt != (*name == "p") {
                return Ok(());
            }
            unsafe { args.SetHandled(true)? };
            shortcut_event(
                "shortcut",
                json!({"key": name, "modifiers": {"cmd": false, "ctrl": true, "alt": alt, "shift": held(VK_SHIFT.0)}}),
            );
            Ok(())
        }));
        unsafe { base.add_AcceleratorKeyPressed(&shortcuts, &mut token)? };

        let _ = unsafe { webview.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(DOCUMENT_SCRIPT), None) };
        if self.category == "visual" {
            // Snapshots of a visual keep its transparency.
            cdp(&webview, "Emulation.setDefaultBackgroundColorOverride", r#"{"color":{"r":0,"g":0,"b":0,"a":0}}"#, |_| {});
        }
        unsafe { webview.Navigate(&HSTRING::from(self.wrapper.as_str()))? };
        self.controller = Some(controller);
        self.webview = Some(webview.clone());
        self.bounds = (0, 0);
        if let Some(placement) = self.placement.clone() {
            self.set_bounds(&placement);
        }
        for script in std::mem::take(&mut self.pending) {
            exec(&webview, &script, |_| {});
        }
        if std::mem::take(&mut self.pending_focus) {
            let _ = unsafe { base.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
        }
        Ok(())
    }

    fn set_bounds(&mut self, placement: &Placement) {
        let Some(controller) = self.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller>().ok()) else {
            return;
        };
        let s = self.scale;
        let bounds = ((placement.logical.0 * s).round() as i32, (placement.logical.1 * s).round() as i32);
        if bounds != self.bounds {
            self.bounds = bounds;
            let _ = unsafe { controller.SetBounds(RECT { left: 0, top: 0, right: bounds.0, bottom: bounds.1 }) };
        }
    }

    fn place(
        &mut self,
        command: &Map<String, Value>,
        occlusions: &[Occlusion],
        d2d: Option<&ID2D1Factory>,
        compositor: Option<&Compositor>,
    ) -> Result<()> {
        let scale = scale_of(self.hwnd);
        if (scale - self.scale).abs() > f64::EPSILON {
            self.scale = scale;
            if let Some(controller) = self.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller3>().ok()) {
                let _ = unsafe { controller.SetRasterizationScale(scale) };
            }
        }
        let (x, y, width, height) = (num(command, "x"), num(command, "y"), num(command, "width"), num(command, "height"));
        let rounded = command
            .get("roundedClips")
            .and_then(Value::as_array)
            .map(|shapes| {
                shapes
                    .iter()
                    .filter_map(|shape| {
                        let values: Vec<f64> = shape.as_array()?.iter().filter_map(Value::as_f64).collect();
                        <[f64; 8]>::try_from(values).ok()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let placement = Placement {
            clip: RoundedRect::uniform(x, y, width, height, 0.0),
            radius: num(command, "radius"),
            rounded,
            offset: (num(command, "offsetX"), num(command, "offsetY")),
            logical: (num(command, "logicalWidth"), num(command, "logicalHeight")),
        };
        self.layer = command.get("layer").and_then(Value::as_i64).unwrap_or(0);
        let s = self.scale as f32;
        self.clip.SetOffset(Vector3 { X: x as f32 * s, Y: y as f32 * s, Z: 0.0 })?;
        let size = Vector2 { X: width as f32 * s, Y: height as f32 * s };
        self.clip.SetSize(size)?;
        self.shade.SetSize(size)?;
        self.web.SetOffset(Vector3 { X: placement.offset.0 as f32 * s, Y: placement.offset.1 as f32 * s, Z: 0.0 })?;
        self.set_bounds(&placement);
        self.placement = Some(placement);
        self.apply_mask(occlusions, d2d, compositor)?;
        // WebView2 bounds do not change the layout viewport; the wrapper sizes the iframe and scales it (device mode).
        if let Some(layout) = command.get("layout").and_then(Value::as_str) {
            self.run(layout.to_owned());
        }
        self.placed = command.get("visible").and_then(Value::as_bool).unwrap_or(false) && width > 0.0 && height > 0.0;
        self.visibility();
        Ok(())
    }

    /// `-[KybernWebHost mask]`: own radius ∩ rounded ancestors − occlusions above, as a `CompositionGeometricClip`; the
    /// same `Mask` answers the pointer filter, so painting and hit-testing agree. Dimming occlusions set the shade.
    fn apply_mask(&mut self, occlusions: &[Occlusion], d2d: Option<&ID2D1Factory>, compositor: Option<&Compositor>) -> Result<()> {
        let (Some(placement), Some(d2d), Some(compositor)) = (&self.placement, d2d, compositor) else { return Ok(()) };
        let mask = Mask::build(placement.clip, placement.radius, &placement.rounded, occlusions, self.layer);
        let s = self.scale;
        if mask != self.mask || (s - self.mask_scale).abs() > f64::EPSILON {
            let base = mask.base.unwrap_or_default();
            let mut geometry: ID2D1Geometry = rounded_path(d2d, base, s)?.cast()?;
            for shape in &mask.intersect {
                geometry = combine(d2d, &geometry, &rounded_path(d2d, *shape, s)?.cast()?, D2D1_COMBINE_MODE_INTERSECT)?;
            }
            for hole in &mask.subtract {
                geometry = combine(d2d, &geometry, &rounded_path(d2d, *hole, s)?.cast()?, D2D1_COMBINE_MODE_EXCLUDE)?;
            }
            let source: IGeometrySource2D = GeometrySource(geometry).into();
            let path = CompositionPath::Create(&source)?;
            let geometry = compositor.CreatePathGeometryWithPath(&path)?;
            self.clip.SetClip(&compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
            self.mask_scale = s;
        }
        if (mask.dim - self.dim).abs() > f64::EPSILON {
            self.dim = mask.dim;
            let alpha = (mask.dim.clamp(0.0, 1.0) * 255.0).round() as u8;
            self.shade.SetBrush(&compositor.CreateColorBrushWithColor(Color { A: alpha, R: 0, G: 0, B: 0 })?)?;
        }
        self.mask = mask;
        Ok(())
    }

    /// `-[KybernWebHost visibility]`: shown while placed in a shown, unminimized window.
    fn visibility(&mut self) {
        let visible = self.placed && unsafe { IsWindowVisible(self.hwnd).as_bool() && !IsIconic(self.hwnd).as_bool() };
        if !visible {
            // Before hiding, so the keyboard does not stay with an invisible page.
            release_focus(self);
        }
        let _ = self.clip.SetIsVisible(visible);
        if self.category != "renderer"
            && let Some(controller) = self.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller>().ok())
        {
            let _ = unsafe { controller.SetIsVisible(visible) };
        }
        if self.last_visible == Some(visible) {
            return;
        }
        self.last_visible = Some(visible);
        let mut event = self.event("visibility");
        event.insert("visible".into(), Value::Bool(visible));
        emit(Value::Object(event));
        if let Some(webview) = &self.webview {
            // macOS suspends media; WebView2 mutes it (a hidden page is also throttled by WebView2).
            if let Ok(webview8) = webview.cast::<ICoreWebView2_8>() {
                let _ = unsafe { webview8.SetIsMuted(!visible) };
            }
        }
        self.run(format!("window.kybernVisible && window.kybernVisible({visible})"));
    }

    /// N3: fade and scale with the host's `paintTransform` on the compositor's clock (macOS: Core Animation). A keyframe
    /// animation without a 0.0 key starts from the value on screen; `fromOpacity`/`fromScale` start an entrance.
    fn present(&self, compositor: &Compositor, command: &Map<String, Value>) -> Result<()> {
        let size = self.clip.Size()?;
        let origin = (num(command, "originX") as f32, num(command, "originY") as f32);
        self.clip.SetCenterPoint(Vector3 { X: size.X * origin.0, Y: size.Y * origin.1, Z: 0.0 })?;
        let (opacity, scale, seconds) = (num(command, "opacity") as f32, num(command, "scale") as f32, num(command, "duration"));
        // Bit 0: running; the rest counts presents, so a finished older animation cannot clear a newer one.
        let ticket = (self.animating.load(Ordering::Acquire) | 1).wrapping_add(2);
        if seconds <= 0.0 {
            self.clip.StopAnimation(&HSTRING::from("Opacity"))?;
            self.clip.StopAnimation(&HSTRING::from("Scale"))?;
            self.clip.SetOpacity(opacity)?;
            self.animating.store(ticket & !1, Ordering::Release);
            return self.clip.SetScale(Vector3 { X: scale, Y: scale, Z: 1.0 });
        }
        let ease: Vec<f32> = command
            .get("ease")
            .and_then(Value::as_array)
            .map(|e| e.iter().filter_map(Value::as_f64).map(|v| v as f32).collect())
            .unwrap_or_default();
        let ease = if ease.len() == 4 { ease } else { vec![0.23, 1.0, 0.32, 1.0] };
        let curve = compositor.CreateCubicBezierEasingFunction(Vector2 { X: ease[0], Y: ease[1] }, Vector2 { X: ease[2], Y: ease[3] })?;
        let duration = TimeSpan { Duration: (seconds * 10_000_000.0) as i64 };
        let batch = compositor.CreateScopedBatch(CompositionBatchTypes::Animation)?;
        let fade = compositor.CreateScalarKeyFrameAnimation()?;
        if let Some(start) = command.get("fromOpacity").and_then(Value::as_f64) {
            fade.InsertKeyFrame(0.0, start as f32)?;
        }
        fade.InsertKeyFrameWithEasingFunction(1.0, opacity, &curve)?;
        fade.SetDuration(duration)?;
        let grow = compositor.CreateVector3KeyFrameAnimation()?;
        if let Some(start) = command.get("fromScale").and_then(Value::as_f64) {
            grow.InsertKeyFrame(0.0, Vector3 { X: start as f32, Y: start as f32, Z: 1.0 })?;
        }
        grow.InsertKeyFrameWithEasingFunction(1.0, Vector3 { X: scale, Y: scale, Z: 1.0 }, &curve)?;
        grow.SetDuration(duration)?;
        self.clip.StartAnimation(&HSTRING::from("Opacity"), &fade)?;
        self.clip.StartAnimation(&HSTRING::from("Scale"), &grow)?;
        batch.End()?;
        self.animating.store(ticket, Ordering::Release);
        let animating = self.animating.clone();
        batch.Completed(&TypedEventHandler::new(move |_, _| {
            let _ = animating.compare_exchange(ticket, ticket & !1, Ordering::AcqRel, Ordering::Acquire);
            Ok(())
        }))?;
        Ok(())
    }

    /// `snapshot`: the document as it looks now, as a PNG at device scale. CDP draws a fresh frame of the viewport
    /// (transparent for visuals); `Visual.tsx` still falls back to the daemon's picture if this is late.
    fn snapshot(&self, command: &Map<String, Value>) {
        let path = text(command, "path").to_owned();
        let token = command.get("token").cloned().unwrap_or(json!(0));
        let mut event = self.event("snapshot");
        event.insert("token".into(), token);
        let (Some(webview), Some(placement)) = (&self.webview, &self.placement) else {
            event.extend([
                ("ok".into(), json!(false)),
                ("path".into(), json!("")),
                ("width".into(), json!(0)),
                ("height".into(), json!(0)),
                ("message".into(), json!("The page has not loaded yet.")),
            ]);
            emit(Value::Object(event));
            return;
        };
        let params = json!({"format": "png", "fromSurface": true, "captureBeyondViewport": false,
            "clip": {"x": 0, "y": 0, "width": placement.logical.0, "height": placement.logical.1, "scale": 1}});
        cdp(webview, "Page.captureScreenshot", &params.to_string(), move |result| {
            let written = result.ok().and_then(|json| {
                let data = serde_json::from_str::<Value>(&json).ok()?.get("data")?.as_str()?.to_owned();
                let png = base64_decode(&data);
                let size = png_size(&png)?;
                std::fs::write(&path, &png).ok()?;
                Some(size)
            });
            event.extend([
                ("ok".into(), json!(written.is_some())),
                ("path".into(), json!(if written.is_some() { path.as_str() } else { "" })),
                ("width".into(), json!(written.map_or(0, |s| s.0))),
                ("height".into(), json!(written.map_or(0, |s| s.1))),
                ("message".into(), json!(if written.is_some() { "" } else { "The page could not be captured." })),
            ]);
            emit(Value::Object(event));
        });
    }

    /// `frame`: `script` (an expression) in the page's frame, answered as `frameResult`. WebView2 has no content worlds,
    /// so this is the page's own world (macOS: the isolated `KybernPreview` world); results are page data either way.
    fn frame(&self, command: &Map<String, Value>) {
        let rid = command.get("rid").and_then(Value::as_str).map(str::to_owned);
        let mut event = self.event("frameResult");
        if let Some(rid) = &rid {
            event.insert("rid".into(), json!(rid));
        }
        let fail = move |mut event: Map<String, Value>, message: &str| {
            if rid.is_some() {
                event.insert("ok".into(), json!(false));
                event.insert("message".into(), json!(message));
                emit(Value::Object(event));
            }
        };
        let script = text(command, "script");
        let (Some(child), true) = (&self.child, self.child_loaded) else {
            fail(event, "The page has not loaded yet.");
            return;
        };
        let wrapped = format!(
            "(()=>{{try{{const value=(\n{script}\n);return {{ok:true,value:value===undefined?null:value}}}}catch(error){{return {{ok:false,message:String(error&&error.message||error)}}}}}})()"
        );
        exec_frame(child, &wrapped, move |result| {
            let answer = result.ok().and_then(|json| serde_json::from_str::<Value>(&json).ok());
            match answer {
                Some(Value::Object(answer)) if answer.get("ok") == Some(&json!(true)) => {
                    event.insert("ok".into(), json!(true));
                    event.insert("value".into(), answer.get("value").cloned().unwrap_or(Value::Null));
                    emit(Value::Object(event));
                }
                Some(Value::Object(answer)) => {
                    fail(event, answer.get("message").and_then(Value::as_str).unwrap_or("The page did not run the script."))
                }
                _ => fail(event, "The page did not run the script."),
            }
        });
    }

    /// `snapshotRect`: a PNG of a CSS-pixel rect of the child frame's viewport, under the temp folder. The wrapper
    /// offsets and scales the child (device mode), so its box is read first, as on macOS.
    fn snapshot_rect(&self, command: &Map<String, Value>) {
        let rid = text(command, "rid").to_owned();
        let path = text(command, "path").to_owned();
        let mut event = self.event("snapshotRect");
        event.insert("rid".into(), json!(rid));
        let fail = |mut event: Map<String, Value>, message: &str| {
            event.insert("ok".into(), json!(false));
            event.insert("message".into(), json!(message));
            emit(Value::Object(event));
        };
        if !snapshot_path_allowed(&path, &std::env::temp_dir()) {
            fail(event, "The snapshot path is not allowed.");
            return;
        }
        let (Some(webview), Some(placement)) = (self.webview.clone(), self.placement.clone()) else {
            fail(event, "The page has not loaded yet.");
            return;
        };
        let wanted = (num(command, "x"), num(command, "y"), num(command, "width"), num(command, "height"));
        let probe = "(()=>{const f=document.querySelector('iframe');if(!f)return null;const r=f.getBoundingClientRect();return [r.left,r.top,r.width/(f.offsetWidth||r.width||1)]})()";
        let device = self.scale;
        let shooter = webview.clone();
        exec(&webview, probe, move |result| {
            let frame: Vec<f64> = result
                .ok()
                .and_then(|json| serde_json::from_str::<Vec<f64>>(&json).ok())
                .filter(|f| f.len() == 3)
                .unwrap_or(vec![0.0, 0.0, 1.0]);
            let scale = if frame[2] > 0.0 { frame[2] } else { 1.0 };
            let (mut x, mut y) = (frame[0] + wanted.0 * scale, frame[1] + wanted.1 * scale);
            let (mut right, mut bottom) = (x + (wanted.2 * scale).max(1.0), y + (wanted.3 * scale).max(1.0));
            x = x.max(0.0);
            y = y.max(0.0);
            right = right.min(placement.logical.0);
            bottom = bottom.min(placement.logical.1);
            if right <= x || bottom <= y {
                fail(event, "The element is not on screen.");
                return;
            }
            let (width, height) = (right - x, bottom - y);
            // macOS asks for min(1200, 2 × width) pixels across; CDP multiplies the clip scale by the device scale.
            let pixels = (width * 2.0).min(1200.0);
            let params = json!({"format": "png", "fromSurface": true, "captureBeyondViewport": false,
                "clip": {"x": x, "y": y, "width": width, "height": height, "scale": pixels / width / device}});
            cdp(&shooter, "Page.captureScreenshot", &params.to_string(), move |result| {
                let written = result.ok().and_then(|json| {
                    let data = serde_json::from_str::<Value>(&json).ok()?.get("data")?.as_str()?.to_owned();
                    std::fs::write(&path, base64_decode(&data)).ok()
                });
                if written.is_none() {
                    fail(event, "The capture could not be saved.");
                    return;
                }
                event.extend([
                    ("ok".into(), json!(true)),
                    ("path".into(), json!(path)),
                    ("width".into(), json!(width)),
                    ("height".into(), json!(height)),
                ]);
                emit(Value::Object(event));
            });
        });
    }

    fn dispose(self) {
        release_focus(&self);
        if let Some(controller) = self.controller.as_ref().and_then(|c| c.cast::<ICoreWebView2Controller>().ok()) {
            let _ = unsafe { controller.Close() };
        }
        if let Ok(parent) = self.clip.Parent()
            && let Ok(children) = parent.Children()
        {
            let _ = children.Remove(&self.clip);
        }
    }
}

/// The child frame's events: its navigations (`navigation` with the frame's URL), and its messages, which come only
/// from [`FRAME_SCRIPT`] in practice: `frame` (a same-document navigation), `escape`, or a picker message.
fn watch_frame(frame: &ICoreWebView2Frame2, id: String, generation: Value, event: impl Fn(&str, Value) + Clone + 'static) -> Result<()> {
    let mut token = 0i64;
    let (done_id, done_generation) = (id.clone(), generation.clone());
    let completed = FrameNavigationCompletedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        let mut success = BOOL(0);
        unsafe { args.IsSuccess(&mut success)? };
        if !success.as_bool() {
            return Ok(());
        }
        let (id, generation) = (done_id.clone(), done_generation.clone());
        with_host(move |host| {
            if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                doc.child_loaded = true;
            }
        });
        // The document-created script already runs in the child; this covers a frame it missed (guarded, runs once).
        // WebView2 raises this only for the frame's first (about:blank) load; `navigation` comes from the script's
        // `frame` message, whose source is the frame's URL (macOS: the `kybernFrame` message's frame info).
        if let Ok(frame) = sender.cast::<ICoreWebView2Frame2>() {
            exec_frame(&frame, FRAME_SCRIPT, |_| {});
        }
        Ok(())
    }));
    unsafe { frame.add_NavigationCompleted(&completed, &mut token)? };
    let (message_id, message_generation, message_event) = (id.clone(), generation.clone(), event.clone());
    let messages = FrameWebMessageReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let source = take(|out| unsafe { args.Source(out) });
        let json = take(|out| unsafe { args.WebMessageAsJson(out) });
        if json.len() > 65536 {
            return Ok(());
        }
        let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(&json) else { return Ok(()) };
        match data.remove("kybernFrame") {
            // The iframe's initial about:blank document is not a navigation the app shows.
            Some(Value::String(kind)) if kind == "frame" => {
                if !source.starts_with("about:") {
                    message_event("navigation", json!({"url": source}))
                }
            }
            Some(Value::String(kind)) if kind == "escape" => {
                let (id, generation) = (message_id.clone(), message_generation.clone());
                with_host(move |host| {
                    if let Some(doc) = host.docs.iter().find(|d| d.id == id && d.generation == generation) {
                        release_focus(doc);
                    }
                });
            }
            Some(Value::Object(body)) => message_event("frameMessage", json!({"data": body})),
            _ => {}
        }
        Ok(())
    }));
    unsafe { frame.add_WebMessageReceived(&messages, &mut token)? };
    let destroyed = FrameDestroyedEventHandler::create(Box::new(move |_, _| {
        let (id, generation) = (id.clone(), generation.clone());
        with_host(move |host| {
            if let Some(doc) = host.docs.iter_mut().find(|d| d.id == id && d.generation == generation) {
                doc.child = None;
                doc.child_loaded = false;
            }
        });
        Ok(())
    }));
    let base: ICoreWebView2Frame = frame.cast()?;
    unsafe { base.add_Destroyed(&destroyed, &mut token) }
}

/// A rounded rectangle with per-corner radii as a Direct2D path, in device pixels.
fn rounded_path(factory: &ID2D1Factory, r: RoundedRect, s: f64) -> Result<ID2D1PathGeometry> {
    let path = unsafe { factory.CreatePathGeometry()? };
    let sink = unsafe { path.Open()? };
    let (x, y, w, h) = ((r.x * s) as f32, (r.y * s) as f32, (r.width * s) as f32, (r.height * s) as f32);
    // Radii larger than half a side would cross; clamp like Core Animation does.
    let limit = (w.min(h) / 2.0).max(0.0);
    let [tl, tr, br, bl] = r.radii.map(|v| ((v * s) as f32).clamp(0.0, limit));
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
    fn TryGetGeometryUsingFactory(&self, _factory: windows::core::Ref<'_, ID2D1Factory>) -> Result<ID2D1Geometry> {
        Ok(self.0.clone())
    }
}
