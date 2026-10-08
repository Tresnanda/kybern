//! Kybern-owned, checksum-pinned Chrome for Testing. Never discovers user browsers.
use anyhow::{Context, Result, anyhow, bail, ensure};
use futures::{SinkExt, StreamExt};
use kybern_protocol::{
    VisualHeight,
    methods::{HtmlConsoleMessage, HtmlPreviewResult},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

const VERSION: &str = "154.0.8037.92";
/// Pin and SHA-256s reviewed against T3 611132c; a bump must update all hashes.
fn release() -> Result<(&'static str, u64, &'static str)> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("mac-arm64", 99_221_129, "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929"),
        ("macos", "x86_64") => ("mac-x64", 104_748_425, "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4"),
        ("linux", "x86_64") => ("linux64", 120_477_194, "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9"),
        ("linux", "aarch64") => ("linux-arm64", 121_182_296, "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6"),
        ("windows", "x86_64" | "aarch64") => ("win64", 120_822_223, "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568"),
        ("windows", "x86") => ("win32", 114_295_943, "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7"),
        _ => bail!("The HTML preview browser is unavailable on this platform. Publish still works."),
    })
}
fn installations() -> &'static Mutex<HashMap<PathBuf, Option<String>>> {
    static INSTALLS: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    INSTALLS.get_or_init(Default::default)
}
fn executable_name() -> &'static str {
    if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" }
}
async fn executable(root: &Path) -> Result<PathBuf> {
    let (platform, bytes, hash) = release()?;
    let cache = root.join("cache/html-preview");
    let destination = cache.join(VERSION);
    let executable = destination.join(format!("chrome-headless-shell-{platform}")).join(executable_name());
    if tokio::fs::try_exists(&executable).await? {
        return Ok(executable);
    }
    let mut installs = installations().lock().map_err(|_| anyhow!("Preview installation is unavailable. Retry."))?;
    if let Some(status) = installs.get(&cache) {
        if let Some(error) = status {
            let error = error.clone();
            installs.remove(&cache);
            bail!("The preview browser could not install: {error}. Retry preview to install again. Publication still works.");
        }
        bail!("Kybern is installing its preview browser (about 120 MB). Retry preview in a minute. Publication works without it.");
    }
    installs.insert(cache.clone(), None);
    drop(installs);
    tokio::spawn(async move {
        let result = install(&cache, &destination, platform, bytes, hash).await;
        if let Ok(mut installs) = installations().lock() {
            match result {
                Ok(()) => {
                    installs.remove(&cache);
                }
                Err(error) => {
                    installs.insert(cache, Some(error.to_string()));
                }
            }
        }
    });
    bail!("Kybern is installing its preview browser (about 120 MB). Retry preview in a minute. Publication works without it.")
}
async fn install(cache: &Path, destination: &Path, platform: &str, size: u64, hash: &str) -> Result<()> {
    tokio::fs::create_dir_all(cache).await?;
    let staging = cache.join(format!("install-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&staging).await?;
    let result = tokio::time::timeout(Duration::from_secs(900), async {
        let archive = staging.join("browser.zip");
        let client = reqwest::Client::builder().timeout(Duration::from_secs(900)).build()?;
        let url =
            format!("https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/{platform}/chrome-headless-shell-{platform}.zip");
        let mut response = client.get(url).send().await?.error_for_status()?;
        ensure!(response.content_length().is_none_or(|n| n == size), "The browser archive size does not match its pin.");
        let mut output = tokio::fs::File::create(&archive).await?;
        let mut digest = Sha256::new();
        let mut received = 0;
        while let Some(chunk) = response.chunk().await? {
            received += chunk.len() as u64;
            ensure!(received <= size, "The browser archive exceeds its pin.");
            digest.update(&chunk);
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        drop(output);
        ensure!(
            received == size && digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>() == hash,
            "The browser archive failed its SHA-256 or size check."
        );
        let unpack = staging.join("unpacked");
        tokio::fs::create_dir(&unpack).await?;
        // Only an exact hash-verified archive reaches the system extractor.
        #[cfg(not(windows))]
        let status = Command::new("unzip").arg("-q").arg(&archive).arg("-d").arg(&unpack).status().await?;
        #[cfg(windows)]
        let status = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]"])
            .arg(&archive)
            .arg(&unpack)
            .status()
            .await?;
        ensure!(status.success(), "Install an archive extractor and retry preview.");
        ensure!(
            tokio::fs::try_exists(unpack.join(format!("chrome-headless-shell-{platform}")).join(executable_name())).await?,
            "The browser archive is incomplete."
        );
        tokio::fs::rename(unpack, destination).await?;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    let _ = tokio::fs::remove_dir_all(staging).await;
    result.context("The browser installation took longer than 15 minutes")?
}

struct Scratch {
    path: PathBuf,
    server: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            server.abort();
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn browser_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    &PERMITS
}
pub(super) async fn capture(root: &Path, html: String, width: u32, appearance: &str) -> Result<HtmlPreviewResult> {
    let executable = executable(root).await?;
    let _permit =
        browser_permits().try_acquire().map_err(|_| anyhow!("Two HTML previews are already rendering. Wait a moment and retry."))?;
    tokio::time::timeout(Duration::from_secs(45), render(root, executable, html, width, appearance))
        .await
        .context("The page took too long to preview. Check scripts or remote resources and retry.")?
}
/// Content height of a page at each width. Never installs the browser: publishing
/// must not depend on it, so an absent browser yields no heights.
pub(super) async fn measure(root: &Path, html: &str, widths: &[u32], fragment: &str) -> Result<Vec<VisualHeight>> {
    let Ok((platform, ..)) = release() else { return Ok(Vec::new()) };
    let executable =
        root.join("cache/html-preview").join(VERSION).join(format!("chrome-headless-shell-{platform}")).join(executable_name());
    if !tokio::fs::try_exists(&executable).await.unwrap_or(false) {
        return Ok(Vec::new());
    }
    let _permit = browser_permits().acquire().await?;
    let mut session = Session::start(root, &executable, html.to_owned(), widths.len()).await?;
    let mut heights = Vec::with_capacity(widths.len());
    for &width in widths {
        let page_url = session.page_url.clone();
        let cdp = &mut session.cdp;
        cdp.call("Emulation.setDeviceMetricsOverride", json!({"width":width,"height":1,"deviceScaleFactor":1,"mobile":false})).await?;
        cdp.call(
            "Emulation.setEmulatedMedia",
            json!({"features":[{"name":"prefers-color-scheme","value":"dark"},{"name":"prefers-reduced-motion","value":"reduce"}]}),
        )
        .await?;
        cdp.loaded = false;
        // A distinct query forces a full document load; layout can depend on the width at load.
        cdp.call("Page.navigate", json!({"url":format!("{page_url}?w={width}{fragment}")})).await?;
        while !cdp.loaded {
            cdp.next().await?;
        }
        let measured =
            cdp.call("Runtime.evaluate", json!({"expression":SETTLE_AND_MEASURE,"awaitPromise":true,"returnByValue":true})).await?;
        let height = measured.pointer("/result/value").and_then(Value::as_u64).unwrap_or(80).clamp(80, 2000) as u32;
        heights.push(VisualHeight { width, height });
    }
    session.shutdown().await;
    Ok(heights)
}
const SETTLE_AND_MEASURE: &str = "document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(Math.ceil(Math.max(document.body.scrollHeight,document.body.getBoundingClientRect().height)))))))";

/// One headless browser, its debugging connection and a page server.
struct Session {
    child: tokio::process::Child,
    cdp: Cdp,
    page_url: String,
    _scratch: Scratch,
}
impl Session {
    /// Serves `html` to up to `requests` loads, then starts the browser on a blank page.
    async fn start(root: &Path, executable: &Path, html: String, requests: usize) -> Result<Session> {
        let profile = root.join("cache/html-preview").join(format!("render-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&profile).await?;
        let mut scratch = Scratch { path: profile.clone(), server: None };
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let path = format!("/{}.html", uuid::Uuid::new_v4());
        let page_url = format!("http://{addr}{path}");
        scratch.server = Some(tokio::spawn(async move {
            for _ in 0..requests {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut request = [0u8; 4096];
                let Ok(n) = stream.read(&mut request).await else { return };
                let head = String::from_utf8_lossy(&request[..n]);
                if !head.starts_with(&format!("GET {path} ")) && !head.starts_with(&format!("GET {path}?")) {
                    return;
                }
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: {}\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    super::POLICY,
                    html.len()
                );
                if stream.write_all(headers.as_bytes()).await.is_ok() {
                    let _ = stream.write_all(html.as_bytes()).await;
                }
            }
        }));
        let mut child = Command::new(executable)
            .args([
                "--headless=new",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--block-new-web-contents",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-sync",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("The preview browser could not start. On Linux, install Chrome's system libraries and sandbox support.")?;
        let port = loop {
            if let Ok(contents) = tokio::fs::read_to_string(profile.join("DevToolsActivePort")).await
                && let Some(port) = contents.lines().next().and_then(|n| n.parse::<u16>().ok())
            {
                break port;
            }
            ensure!(
                child.try_wait()?.is_none(),
                "The preview browser exited. On Linux, install Chrome's system libraries and sandbox support."
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
        let targets: Value = client.get(format!("http://127.0.0.1:{port}/json/list")).send().await?.json().await?;
        let url = targets
            .as_array()
            .and_then(|targets| targets.iter().find(|target| target["type"] == "page"))
            .and_then(|target| target["webSocketDebuggerUrl"].as_str())
            .ok_or_else(|| anyhow!("The preview browser has no page target."))?;
        let (socket, _) = tokio_tungstenite::connect_async(url).await?;
        let mut cdp = Cdp { socket, id: 0, logs: Vec::new(), page_url: page_url.clone(), loaded: false };
        cdp.call("Page.enable", json!({})).await?;
        cdp.call("Runtime.enable", json!({})).await?;
        cdp.call("Log.enable", json!({})).await?;
        Ok(Session { child, cdp, page_url, _scratch: scratch })
    }
    async fn shutdown(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}
async fn render(root: &Path, executable: PathBuf, html: String, width: u32, appearance: &str) -> Result<HtmlPreviewResult> {
    let mut session = Session::start(root, &executable, html, 1).await?;
    let page_url = session.page_url.clone();
    let cdp = &mut session.cdp;
    cdp.call("Emulation.setDeviceMetricsOverride", json!({"width":width,"height":1,"deviceScaleFactor":1,"mobile":false})).await?;
    cdp.call(
        "Emulation.setEmulatedMedia",
        json!({"features":[{"name":"prefers-color-scheme","value":appearance},{"name":"prefers-reduced-motion","value":"reduce"}]}),
    )
    .await?;
    cdp.call("Page.navigate", json!({"url":page_url})).await?;
    while !cdp.loaded {
        cdp.next().await?;
    }
    let measured = cdp.call("Runtime.evaluate", json!({"expression":SETTLE_AND_MEASURE,"awaitPromise":true,"returnByValue":true})).await?;
    let content_height = measured.pointer("/result/value").and_then(Value::as_u64).unwrap_or(80).clamp(1, 100_000) as u32;
    let captured_height = content_height.clamp(80, 2000);
    cdp.call("Emulation.setDeviceMetricsOverride", json!({"width":width,"height":captured_height,"deviceScaleFactor":1,"mobile":false}))
        .await?;
    let result = cdp
        .call(
            "Page.captureScreenshot",
            json!({"format":"png","captureBeyondViewport":false,"clip":{"x":0,"y":0,"width":width,"height":captured_height,"scale":1}}),
        )
        .await?;
    let screenshot = result["data"].as_str().ok_or_else(|| anyhow!("The preview browser returned no screenshot."))?.to_owned();
    ensure!(
        screenshot.len() <= 1800 * 1024,
        "The screenshot exceeds the tool image limit. Preview at a smaller width or simplify the page."
    );
    let console_messages = std::mem::take(&mut session.cdp.logs);
    session.shutdown().await;
    Ok(HtmlPreviewResult { width, content_height, captured_height, console_messages, missing_images: Vec::new(), screenshot })
}
struct Cdp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    logs: Vec<HtmlConsoleMessage>,
    page_url: String,
    loaded: bool,
}
impl Cdp {
    async fn next(&mut self) -> Result<Value> {
        loop {
            let frame = self.socket.next().await.ok_or_else(|| anyhow!("The preview browser disconnected."))??;
            if !frame.is_text() {
                continue;
            }
            let message: Value = serde_json::from_str(frame.to_text()?)?;
            let method = message["method"].as_str().unwrap_or("");
            if method == "Page.loadEventFired" {
                self.loaded = true;
            }
            let params = &message["params"];
            let log = match method {
                "Runtime.consoleAPICalled" => Some((
                    match params["type"].as_str().unwrap_or("log") {
                        "error" | "assert" => "error",
                        "warning" | "warn" => "warning",
                        "info" => "info",
                        _ => "log",
                    },
                    params["args"]
                        .as_array()
                        .map(|args| {
                            args.iter()
                                .map(|arg| {
                                    arg["value"]
                                        .as_str()
                                        .or_else(|| arg["description"].as_str())
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| arg["value"].to_string())
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default(),
                )),
                "Runtime.exceptionThrown" => Some((
                    "error",
                    params
                        .pointer("/exceptionDetails/exception/description")
                        .or_else(|| params.pointer("/exceptionDetails/text"))
                        .and_then(Value::as_str)
                        .unwrap_or("Uncaught exception")
                        .to_owned(),
                )),
                "Log.entryAdded" => Some((
                    if params["entry"]["level"] == "error" { "error" } else { "warning" },
                    params["entry"]["text"].as_str().unwrap_or("").to_owned(),
                )),
                _ => None,
            };
            if let Some((level, text)) = log
                && self.logs.len() < 100
            {
                self.logs.push(HtmlConsoleMessage {
                    level: level.into(),
                    text: text.replace(&self.page_url, "page.html").chars().take(2000).collect(),
                });
            }
            return Ok(message);
        }
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        let id = self.id;
        self.socket.send(Message::text(json!({"id":id,"method":method,"params":params}).to_string())).await?;
        loop {
            let message = self.next().await?;
            if message["id"].as_u64() == Some(id) {
                ensure!(message.get("error").is_none(), "Preview command {method} failed: {}", message["error"]);
                return Ok(message["result"].clone());
            }
        }
    }
}
