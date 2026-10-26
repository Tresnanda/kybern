//! `kybern-webview.dll`: the Windows counterpart of `native/webview.m`, behind the same C exports.
//!
//! `src/native/webview.ts` sends JSON commands with `kybern_web_command` from Bun's thread and drains JSON events with
//! `kybern_web_next` when the threadsafe callback given to `kybern_web_init` fires. Every WebView2 and composition call
//! runs on GPUI's UI thread, the thread that owns the window (`host.rs`); this file only queues.
//!
//! - `mask`: the clip/occlusion model shared by the composition clip and the pointer filter (unit-tested anywhere).
//! - `policy`: URL and path rules plus the small decoders the host needs (unit-tested anywhere).
//! - `pointer`: who gets a mouse message while buttons are held (unit-tested anywhere).
//! - `wake`: the flag between Bun's thread and the UI thread (unit-tested anywhere).
//! - `host` (Windows): WebView2 `CompositionController`s under a Windows.UI.Composition `DesktopWindowTarget` (topmost)
//!   on GPUI's HWND, whose own DirectComposition target the zed fork creates as not topmost.

use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char};
use std::sync::Mutex;

pub mod mask;
pub mod pointer;
pub mod policy;
pub mod wake;

#[cfg(windows)]
mod host;

struct Events {
    queue: VecDeque<CString>,
    /// The string `kybern_web_next` last returned; it stays valid until the next call (macOS: `lastEvent`).
    last: Option<CString>,
    signal: Option<extern "C" fn()>,
}

static EVENTS: Mutex<Events> = Mutex::new(Events { queue: VecDeque::new(), last: None, signal: None });

/// Queue one event for JS. Same limits as macOS: at most 512 queued, 64 KB each; the callback fires when the queue
/// stops being empty, and JS drains it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn emit(event: serde_json::Value) {
    let Ok(text) = CString::new(event.to_string()) else { return };
    if text.as_bytes().len() > 65536 {
        return;
    }
    let signal = {
        let Ok(mut events) = EVENTS.lock() else { return };
        if events.queue.len() >= 512 {
            return;
        }
        let wake = events.queue.is_empty();
        events.queue.push_back(text);
        if wake { events.signal } else { None }
    };
    if let Some(signal) = signal {
        signal();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kybern_web_init(callback: Option<extern "C" fn()>) {
    if let Ok(mut events) = EVENTS.lock() {
        events.signal = callback;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kybern_web_next() -> *const c_char {
    let Ok(mut events) = EVENTS.lock() else { return std::ptr::null() };
    let next = events.queue.pop_front();
    events.last = next;
    events.last.as_ref().map_or(std::ptr::null(), |text| text.as_ptr())
}

/// # Safety
/// `json` is a NUL-terminated UTF-8 string (`webview.ts` `command`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kybern_web_command(json: *const c_char) {
    if json.is_null() {
        return;
    }
    let Ok(text) = unsafe { CStr::from_ptr(json) }.to_str() else { return };
    let Ok(serde_json::Value::Object(command)) = serde_json::from_str::<serde_json::Value>(text) else { return };
    #[cfg(windows)]
    host::command(command);
    #[cfg(not(windows))]
    let _ = command;
}

/// 1 when the Microsoft Edge WebView2 Runtime (or a matching Edge channel) is installed and at least
/// [`policy::MIN_RUNTIME`], else 0. `webview.ts` reads it once to decide `webHost.available`; without a runtime the WP4
/// fallbacks stay.
#[unsafe(no_mangle)]
pub extern "C" fn kybern_web_available() -> i32 {
    #[cfg(windows)]
    return i32::from(host::runtime_supported());
    #[cfg(not(windows))]
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_queue_in_order_and_wake_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static WAKES: AtomicUsize = AtomicUsize::new(0);
        extern "C" fn wake() {
            WAKES.fetch_add(1, Ordering::SeqCst);
        }
        kybern_web_init(Some(wake));
        emit(serde_json::json!({"id": "a", "type": "created"}));
        emit(serde_json::json!({"id": "a", "type": "loaded"}));
        assert_eq!(WAKES.load(Ordering::SeqCst), 1, "a wake only when the queue stops being empty");
        let read = || {
            let raw = kybern_web_next();
            (!raw.is_null()).then(|| unsafe { CStr::from_ptr(raw) }.to_str().unwrap().to_owned())
        };
        assert_eq!(read().as_deref(), Some(r#"{"id":"a","type":"created"}"#));
        assert_eq!(read().as_deref(), Some(r#"{"id":"a","type":"loaded"}"#));
        assert_eq!(read(), None);
        emit(serde_json::json!({"big": "x".repeat(70_000)}));
        assert_eq!(read(), None, "events over 64 KB are dropped, as on macOS");
        kybern_web_init(None);
    }
}
