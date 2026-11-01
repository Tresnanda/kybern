//! One supervised SDK process per account/environment. Logical sessions retain
//! independent event streams and capabilities. Only confirmed native IDs are
//! resumed after a crash; an ambiguously admitted prompt is never replayed.
//! The host outlives its last session by `HOST_LINGER`, with its warm
//! workspaces, so the next conversation on the account starts warm.
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::ndjson::{NdjsonChild, SessionLifetime};
use crate::{DriverError, DriverEvent, ProbeContext, Result};

type Reply = oneshot::Sender<std::result::Result<Value, String>>;
type Hosts = Mutex<HashMap<[u8; 32], Arc<Hub>>>;
static HOSTS: OnceLock<Hosts> = OnceLock::new();
#[cfg(not(test))]
pub(super) const HOST_LINGER: Duration = Duration::from_secs(10 * 60);
#[cfg(test)]
pub(super) const HOST_LINGER: Duration = Duration::from_millis(1500);
/// Recent host stderr kept for crash diagnostics.
const STDERR_LINES: usize = 64;
const RESTORING: &str = "Cursor is resuming after its host restarted.";
const SCOPED_ENV: [&str; 7] = [
    "SUDO_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT",
    "KYBERN_ASKPASS_URL",
    "KYBERN_ASKPASS_TOKEN",
];

enum Command {
    Register(String, mpsc::Sender<DriverEvent>),
    Catalog(Value),
    Call { session: String, operation: String, params: Value, reply: Reply },
    Drop(String),
}

struct Hub {
    tx: mpsc::UnboundedSender<Command>,
    closed: Arc<AtomicBool>,
}

struct Slot {
    events: mpsc::Sender<DriverEvent>,
    stream: super::stream::Stream,
    open: Option<Value>,
    restoring: bool,
}

struct Pending {
    session: String,
    operation: String,
    params: Value,
    reply: Option<Reply>,
    deadline: Instant,
}

pub(crate) struct Connection {
    hub: Arc<Hub>,
    id: String,
    events: mpsc::Sender<DriverEvent>,
    env: BTreeMap<String, String>,
    catalog: Option<Value>,
    closed: AtomicBool,
}

fn account_context(context: &ProbeContext) -> ProbeContext {
    let mut account = context.clone();
    // cwd is not part of account_key: every request carries its own workspace.
    account.env.retain(|key, _| !SCOPED_ENV.contains(&key.as_str()) && key != "KYBERN_CURSOR_CATALOG");
    account
}

fn account_key(context: &ProbeContext) -> Result<[u8; 32]> {
    // Hash secrets rather than retaining them as cache keys or logging them.
    let bytes = serde_json::to_vec(&(&context.binary, &context.env)).map_err(|error| DriverError::Protocol(error.to_string()))?;
    Ok(Sha256::digest(bytes).into())
}

/// Discovery refreshes an already-running account without restarting its agents.
pub(super) fn update_catalog(context: &ProbeContext, catalog: Value) {
    let Ok(key) = account_key(&account_context(context)) else { return };
    let Some(hosts) = HOSTS.get() else { return };
    let hosts = hosts.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(host) = hosts.get(&key) {
        let _ = host.tx.send(Command::Catalog(catalog));
    }
}

impl Connection {
    pub(crate) fn spawn(context: &ProbeContext) -> Result<(Self, mpsc::Receiver<DriverEvent>)> {
        let account = account_context(context);
        let key = account_key(&account)?;
        // Registration happens under this lock, which is what lets a lingering
        // host retire itself without racing a new session (see `serve`).
        let mut hosts = HOSTS.get_or_init(Mutex::default).lock().unwrap_or_else(|poison| poison.into_inner());
        hosts.retain(|_, host| !host.closed.load(Ordering::Acquire));
        let hub = match hosts.get(&key) {
            Some(hub) => {
                tracing::debug!(target: "kybern_drivers::cursor::timing", phase = "host_reused", "Cursor startup timing");
                hub.clone()
            }
            None => {
                let started = Instant::now();
                let child = Arc::new(NdjsonChild::spawn(host_command(&account)?)?);
                tracing::debug!(target: "kybern_drivers::cursor::timing", phase = "node_spawn", elapsed_ms = started.elapsed().as_millis(), "Cursor startup timing");
                let (tx, rx) = mpsc::unbounded_channel();
                let closed = Arc::new(AtomicBool::new(false));
                let hub = Arc::new(Hub { tx, closed: closed.clone() });
                tokio::spawn(serve(key, Arc::downgrade(&hub), account, child, rx, closed));
                hosts.insert(key, hub.clone());
                hub
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (events, receiver) = mpsc::channel(1024);
        hub.tx.send(Command::Register(id.clone(), events.clone())).map_err(|_| DriverError::ProcessExited("Cursor host stopped".into()))?;
        let env = context
            .env
            .iter()
            .filter(|(key, _)| SCOPED_ENV.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let catalog = context.env.get("KYBERN_CURSOR_CATALOG").and_then(|value| serde_json::from_str(value).ok());
        Ok((Self { hub, id, events, env, catalog, closed: AtomicBool::new(false) }, receiver))
    }

    pub(crate) async fn call(&self, operation: &str, mut params: Value) -> Result<Value> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DriverError::ProcessExited("Cursor session is closed".into()));
        }
        if operation == "open" {
            params["env"] = json!(self.env);
            if let Some(catalog) = &self.catalog {
                params["catalog"] = catalog.clone();
            }
        }
        let waiting = Instant::now();
        loop {
            let (reply, result) = oneshot::channel();
            self.hub
                .tx
                .send(Command::Call { session: self.id.clone(), operation: operation.into(), params: params.clone(), reply })
                .map_err(|_| DriverError::ProcessExited("Cursor host stopped; send again to resume".into()))?;
            let result = result.await.map_err(|_| DriverError::ProcessExited("Cursor host stopped".into()))?;
            // This sentinel means the request was never written to Node, so
            // waiting for automatic resume cannot duplicate an admitted send.
            if result.as_ref().is_err_and(|error| error == RESTORING) && waiting.elapsed() < Duration::from_secs(60) {
                tokio::time::sleep(Duration::from_millis(25)).await;
                continue;
            }
            return result.map_err(DriverError::Protocol);
        }
    }

    pub(crate) async fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event).await;
    }

    pub(crate) async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let (reply, result) = oneshot::channel();
        if self.hub.tx.send(Command::Call { session: self.id.clone(), operation: "close".into(), params: json!({}), reply }).is_err() {
            return Ok(());
        }
        result.await.map_err(|_| DriverError::ProcessExited("Cursor host stopped".into()))?.map(|_| ()).map_err(DriverError::Protocol)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.hub.tx.send(Command::Drop(self.id.clone()));
        }
    }
}

fn host_command(context: &ProbeContext) -> Result<tokio::process::Command> {
    let mut command = super::runtime::command(context, "stdio")?;
    // Workspace executors linger exactly as long as the host does.
    command.env("KYBERN_CURSOR_LINGER_MS", HOST_LINGER.as_millis().to_string());
    Ok(command)
}

/// Keeps the newest stderr lines for diagnostics and forwards the host's
/// per-step timings, so a long-lived host never reports stale output.
async fn drain_stderr(child: &NdjsonChild, recent: &mut VecDeque<String>) {
    let mut stderr = child.stderr.lock().await;
    while let Ok(line) = stderr.try_recv() {
        if let Some(timing) = line.strip_prefix("cursor_timing ") {
            tracing::debug!(target: "kybern_drivers::cursor::timing", "{timing}");
            continue;
        }
        if recent.len() == STDERR_LINES {
            recent.pop_front();
        }
        recent.push_back(line);
    }
}

async fn write(child: &NdjsonChild, session: &str, operation: &str, mut params: Value) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    params["id"] = json!(id);
    params["session"] = json!(session);
    params["type"] = json!(operation);
    tokio::time::timeout(Duration::from_secs(60), child.write(&params))
        .await
        .map_err(|_| DriverError::Protocol("Cursor host stopped accepting requests".into()))??;
    Ok(id)
}

async fn retire(child: &NdjsonChild, pending: &mut HashMap<String, Pending>, session: &str) -> Result<()> {
    let id = write(child, session, "close", json!({})).await?;
    pending.insert(
        id,
        Pending {
            session: session.into(),
            operation: "close".into(),
            params: json!({}),
            reply: None,
            deadline: Instant::now() + Duration::from_secs(5),
        },
    );
    Ok(())
}

fn deliver(slot: &mut Slot, events: Vec<DriverEvent>) -> bool {
    let mut events = events.into_iter();
    while let Some(event) = events.next() {
        match slot.events.try_send(event) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(event)) => {
                // A slow consumer must not block a sibling's cancel/close or
                // require an unbounded queue. Preserve this final batch, then
                // retire just the stalled session with an explicit failure.
                let sender = slot.events.clone();
                let mut stream = std::mem::take(&mut slot.stream);
                tokio::spawn(async move {
                    for event in std::iter::once(event).chain(events).chain(stream.exited()).chain([DriverEvent::Exited {
                        code: None,
                        error: Some("Cursor output consumer stopped keeping up. Reopen the saved conversation to continue.".into()),
                    }]) {
                        if sender.send(event).await.is_err() {
                            break;
                        }
                    }
                });
                return false;
            }
        }
    }
    true
}

async fn serve(
    key: [u8; 32],
    hub: Weak<Hub>,
    context: ProbeContext,
    mut child: Arc<NdjsonChild>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    closed: Arc<AtomicBool>,
) {
    let mut lifetime = SessionLifetime::new(child.clone());
    let mut slots: HashMap<String, Slot> = HashMap::new();
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut crashes = VecDeque::new();
    let mut recent = VecDeque::new();
    let mut timer = tokio::time::interval(Duration::from_millis(250));
    let mut failed = false;
    // Set while no session is registered; the host retires once it is older than HOST_LINGER.
    let mut idle_since = Some(Instant::now());
    loop {
        if failed {
            let now = Instant::now();
            crashes.retain(|when| now.duration_since(*when) < Duration::from_secs(60));
            crashes.push_back(now);
            drain_stderr(&child, &mut recent).await;
            let diagnostic = super::runtime::diagnostic(recent.iter().map(String::as_str).collect::<Vec<_>>().join("\n").as_bytes());
            recent.clear();
            for (_, call) in pending.drain() {
                if call.operation == "close" {
                    slots.remove(&call.session);
                }
                if let Some(reply) = call.reply {
                    let _ = reply.send(Err(format!(
                        "{diagnostic}. Cursor host stopped during admission. Send again to resume; the prompt was not replayed."
                    )));
                }
            }
            slots.retain(|_, slot| {
                let events = slot.stream.exited();
                deliver(slot, events)
            });
            child.kill().await;
            if crashes.len() > 3 || slots.is_empty() {
                break;
            }
            let next = host_command(&context).and_then(NdjsonChild::spawn);
            match next {
                Ok(next) => {
                    drop(lifetime);
                    child = Arc::new(next);
                    lifetime = SessionLifetime::new(child.clone());
                    tracing::warn!(sessions = slots.len(), "restarting Cursor account host and resuming confirmed agents");
                }
                Err(error) => {
                    tracing::warn!(%error,"could not restart Cursor account host");
                    break;
                }
            }
            let mut lost = Vec::new();
            for (id, slot) in &mut slots {
                if let Some(open) = &slot.open {
                    slot.restoring = true;
                    match write(&child, id, "open", open.clone()).await {
                        Ok(request) => {
                            pending.insert(
                                request,
                                Pending {
                                    session: id.clone(),
                                    operation: "open".into(),
                                    params: open.clone(),
                                    reply: None,
                                    deadline: Instant::now() + Duration::from_secs(60),
                                },
                            );
                        }
                        Err(_) => {
                            lost.push(id.clone());
                        }
                    }
                } else {
                    lost.push(id.clone());
                }
            }
            for id in lost {
                if let Some(slot) = slots.remove(&id) {
                    let _ = slot
                        .events
                        .send(DriverEvent::Exited {
                            code: None,
                            error: Some("Cursor session was not confirmed before the host stopped; send again to resume".into()),
                        })
                        .await;
                }
            }
            failed = false;
        }
        let incoming = async { child.lines.lock().await.recv().await };
        tokio::select! {
            command = commands.recv() => {
                match command {
                    None => break,
                    Some(Command::Register(id,events)) => { idle_since = None; slots.insert(id,Slot{events,stream:Default::default(),open:None,restoring:false}); }
                    Some(Command::Catalog(catalog)) => {
                        for slot in slots.values_mut() { if let Some(open)=&mut slot.open {open["catalog"]=catalog.clone();} }
                        if write(&child,"catalog","catalog",json!({"catalog":catalog})).await.is_err() {failed=true;}
                    }
                    Some(Command::Drop(id)) => { slots.remove(&id); if retire(&child,&mut pending,&id).await.is_err() {failed=true;} }
                    Some(Command::Call{session,operation,params,reply}) => {
                        let Some(slot) = slots.get(&session) else { let _=reply.send(Err("Cursor session is closed".into())); continue };
                        if slot.restoring && operation != "close" { let _=reply.send(Err(RESTORING.into())); continue; }
                        match write(&child,&session,&operation,params.clone()).await {
                            Ok(id) => { pending.insert(id,Pending{session,deadline:Instant::now()+Duration::from_secs(if operation=="close" {5}else{60}),operation,params,reply:Some(reply)}); }
                            Err(error) => { let _=reply.send(Err(error.to_string())); failed=true; }
                        }
                    }
                }
            }
            value = incoming => {
                let Some(value) = value else { failed=true; continue };
                if let Some(id) = value["id"].as_str() {
                    if let Some(call) = pending.remove(id) {
                        let result = value["error"].as_str().map_or_else(||Ok(value["result"].clone()),|error|Err(error.to_owned()));
                        if let Some(slot) = slots.get_mut(&call.session) {
                            if let Ok(result) = &result {
                                match call.operation.as_str() {
                                    "open" => {
                                        if result["agentId"].as_str().is_some_and(|id|!id.is_empty()) {
                                            let mut open=call.params; open["agentId"]=result["agentId"].clone(); slot.open=Some(open);
                                        }
                                        slot.restoring=false;
                                    }
                                    "set_model" => { if let Some(open)=&mut slot.open { open["model"]=call.params["model"].clone(); open["effort"]=Value::Null; } }
                                    "set_effort" => { if let Some(open)=&mut slot.open { open["effort"]=call.params["effort"].clone(); } }
                                    "set_mode" => { if let Some(open)=&mut slot.open { open["mode"]=call.params["mode"].clone(); } }
                                    _ => {}
                                }
                            } else if call.reply.is_none() {
                                let _=slot.events.send(DriverEvent::Exited{code:None,error:Some(format!("Cursor could not resume after its host restarted: {}",result.as_ref().unwrap_err()))}).await;
                            }
                        }
                        if call.operation=="close" {
                            slots.remove(&call.session);
                            pending.retain(|_,pending| {
                                if pending.session != call.session { return true; }
                                if let Some(reply)=pending.reply.take() { let _=reply.send(Err("Cursor session closed before admission completed".into())); }
                                false
                            });
                        }
                        if let Some(reply)=call.reply { let _=reply.send(result); }
                    }
                } else {
                    // Untagged events are accepted only by the single-session
                    // fixture/legacy host, never guessed between live agents.
                    let id=value["session"].as_str().map(str::to_owned).or_else(||(slots.len()==1).then(||slots.keys().next().unwrap().clone()));
                    if let Some(id)=id && let Some(slot)=slots.get_mut(&id) {
                            let events=slot.stream.handle(&value);
                            if !deliver(slot,events) {
                                slots.remove(&id);
                                if retire(&child,&mut pending,&id).await.is_err() {failed=true;}
                            }
                    }
                }
            }
            _ = timer.tick() => {
                drain_stderr(&child, &mut recent).await;
                if pending.values().any(|call|call.deadline<=Instant::now()) {
                    tracing::warn!("Cursor SDK operation timed out; retiring host before any prompt can be replayed");
                    failed=true;
                }
            }
        }
        if !slots.is_empty() || !pending.is_empty() {
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= HOST_LINGER {
            // Sessions register while holding HOSTS, so an empty queue under
            // the lock means no new session can still be bound to this host.
            let mut hosts = HOSTS.get_or_init(Mutex::default).lock().unwrap_or_else(|poison| poison.into_inner());
            if commands.is_empty() {
                closed.store(true, Ordering::Release);
                if hosts.get(&key).is_some_and(|current| std::ptr::eq(Arc::as_ptr(current), hub.as_ptr())) {
                    hosts.remove(&key);
                }
                break;
            }
        }
    }
    closed.store(true, Ordering::Release);
    {
        let mut hosts = HOSTS.get_or_init(Mutex::default).lock().unwrap_or_else(|poison| poison.into_inner());
        if hosts.get(&key).is_some_and(|current| std::ptr::eq(Arc::as_ptr(current), hub.as_ptr())) {
            hosts.remove(&key);
        }
    }
    for (_, call) in pending {
        if let Some(reply) = call.reply {
            let _ = reply.send(Err("Cursor host closed".into()));
        }
    }
    for (_, mut slot) in slots {
        let mut events = slot.stream.exited();
        events.push(DriverEvent::Exited {
            code: None,
            error: Some("Cursor host could not recover. Send again to resume the saved conversation.".into()),
        });
        deliver(&mut slot, events);
    }
    child.close().await;
    drop(lifetime);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn fixture(root: &std::path::Path) -> ProbeContext {
        let path = root.join("node-fixture");
        kybern_protocol::process::write_executable(
            &path,
            r#"#!/usr/bin/env python3
import json, os, sys
agents = {}
log = os.path.join(os.path.dirname(__file__), 'requests.jsonl')
for line in sys.stdin:
    request = json.loads(line)
    session = request['session']
    op = request['type']
    with open(log,'a') as file:
        file.write(json.dumps({'op':op,'session':session,'pid':os.getpid(),'agentId':request.get('agentId')})+'\n')
    if op == 'test_crash': os._exit(1)
    if op == 'open':
        agents[session] = request
        agents[session]['agentId'] = request.get('agentId') or ('agent-'+session)
    if op in ('send','flood'):
        print(json.dumps({'session':session,'type':'run_started','runId':session}),flush=True)
        for _ in range(2500 if op == 'flood' else 1):
            print(json.dumps({'session':session,'type':'update','runId':session,'update':{'type':'text-delta','text':session}}),flush=True)
    result = {'pid':os.getpid(),**agents.get(session,{})}
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
    if op == 'close': agents.pop(session,None)
"#,
        )
        .unwrap();
        ProbeContext {
            cwd: Some(root.into()),
            env: BTreeMap::from([
                ("KYBERN_CURSOR_NODE".into(), path.display().to_string()),
                ("KYBERN_CURSOR_SDK_DIR".into(), root.display().to_string()),
            ]),
            ..Default::default()
        }
    }

    fn spawn(context: &ProbeContext) -> (Connection, mpsc::Receiver<DriverEvent>) {
        for _ in 0..50 {
            match Connection::spawn(context) {
                Err(DriverError::Io(error)) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                result => return result.unwrap(),
            }
        }
        Connection::spawn(context).unwrap()
    }

    #[tokio::test]
    async fn shares_accounts_across_workspaces_and_keeps_capabilities_events_and_close_separate() {
        let root = tempfile::tempdir().unwrap();
        let mut context = fixture(root.path());
        context.env.insert("KYBERN_ASKPASS_TOKEN".into(), "first-capability".into());
        let (first, mut events) = spawn(&context);
        let a = first.call("open", json!({"cwd":root.path(),"model":"first","mode":"auto"})).await.unwrap();
        let second_dir = root.path().join("other");
        std::fs::create_dir(&second_dir).unwrap();
        context.cwd = Some(second_dir.clone());
        context.env.insert("KYBERN_ASKPASS_TOKEN".into(), "second-capability".into());
        let (second, mut second_events) = spawn(&context);
        let b = second.call("open", json!({"cwd":second_dir,"model":"second","mode":"full-access"})).await.unwrap();
        assert_eq!(a["pid"], b["pid"]);
        assert_eq!(a["env"]["KYBERN_ASKPASS_TOKEN"], "first-capability");
        assert_eq!(b["env"]["KYBERN_ASKPASS_TOKEN"], "second-capability");
        first.call("send", json!({})).await.unwrap();
        assert!(matches!(events.recv().await, Some(DriverEvent::ResponseStarted)));
        assert!(matches!(events.recv().await,Some(DriverEvent::TextDelta{delta,..}) if delta==first.id));
        assert!(second_events.try_recv().is_err());
        first.close().await.unwrap();
        assert_eq!(second.call("inspect", json!({})).await.unwrap()["pid"], b["pid"]);
        // Changing account credentials never borrows the first host.
        context.env.insert("CURSOR_API_KEY".into(), "fixture-other-account".into());
        let (other, _) = spawn(&context);
        assert_ne!(other.call("open", json!({})).await.unwrap()["pid"], b["pid"]);
        other.close().await.unwrap();
        second.close().await.unwrap();
    }

    #[tokio::test]
    async fn the_host_lingers_for_the_next_session_then_retires() {
        let root = tempfile::tempdir().unwrap();
        let context = fixture(root.path());
        let (first, _) = spawn(&context);
        let pid = first.call("open", json!({})).await.unwrap()["pid"].clone();
        first.close().await.unwrap();
        drop(first);
        tokio::time::sleep(HOST_LINGER / 3).await;
        let (second, _) = spawn(&context);
        assert_eq!(second.call("open", json!({})).await.unwrap()["pid"], pid);
        second.close().await.unwrap();
        drop(second);
        tokio::time::sleep(HOST_LINGER + Duration::from_secs(1)).await;
        let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().unwrap().success();
        assert!(!alive, "a retired host process must exit");
        let (third, _) = spawn(&context);
        assert_ne!(third.call("open", json!({})).await.unwrap()["pid"], pid);
        third.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_stalled_output_consumer_cannot_block_a_siblings_control_requests() {
        let root = tempfile::tempdir().unwrap();
        let context = fixture(root.path());
        let (first, _stalled) = spawn(&context);
        let (second, _) = spawn(&context);
        first.call("open", json!({})).await.unwrap();
        let original = second.call("open", json!({})).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            first.call("flood", json!({})).await.unwrap();
            assert_eq!(second.call("inspect", json!({})).await.unwrap()["pid"], original["pid"]);
            second.close().await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn crash_resumes_every_confirmed_agent_and_fails_the_old_turn_without_replaying_its_prompt() {
        let root = tempfile::tempdir().unwrap();
        let context = fixture(root.path());
        let (first, mut events) = spawn(&context);
        let (second, _) = spawn(&context);
        let first_open = first.call("open", json!({"model":"m1","mode":"auto"})).await.unwrap();
        let second_open = second.call("open", json!({"model":"m2","mode":"full-access"})).await.unwrap();
        first.call("set_effort", json!({"effort":"high"})).await.unwrap();
        first.call("send", json!({"message":{"text":"fixture only"}})).await.unwrap();
        assert!(first.call("test_crash", json!({})).await.is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !matches!(events.recv().await, Some(DriverEvent::TurnFailed { .. })) {}
        })
        .await
        .unwrap();
        let restored = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let (Ok(a), Ok(b)) = (first.call("inspect", json!({})).await, second.call("inspect", json!({})).await) {
                    break (a, b);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_ne!(restored.0["pid"], first_open["pid"]);
        assert_eq!(restored.0["pid"], restored.1["pid"]);
        assert_eq!(restored.0["agentId"], first_open["agentId"]);
        assert_eq!(restored.1["agentId"], second_open["agentId"]);
        assert_eq!(restored.0["model"], "m1");
        assert_eq!(restored.0["effort"], "high");
        assert_eq!(restored.1["mode"], "full-access");
        let requests = std::fs::read_to_string(root.path().join("requests.jsonl")).unwrap();
        assert_eq!(requests.lines().filter(|line| serde_json::from_str::<Value>(line).unwrap()["op"] == "send").count(), 1);
        first.close().await.unwrap();
        second.close().await.unwrap();
    }
}
