//! Dumps JSON Schema for every wire type to stdout (or a directory).
//!
//! Usage: `cargo run -p kybern-protocol --bin kybern-schema [-- <out_dir>]`

use kybern_protocol::methods::*;
use kybern_protocol::*;
use schemars::{JsonSchema, schema_for};
use serde_json::{Map, Value, json};

fn add<T: JsonSchema>(defs: &mut Map<String, Value>, name: &str) {
    defs.insert(name.to_string(), serde_json::to_value(schema_for!(T)).unwrap());
}

fn method<M: Method>(list: &mut Vec<Value>) {
    list.push(json!({
        "name": M::NAME,
        "scope": M::SCOPE,
        "params": schema_for!(M::Params),
        "result": schema_for!(M::Result),
    }));
}

fn main() {
    let mut types = Map::new();
    add::<RpcRequest>(&mut types, "RpcRequest");
    add::<RpcResponse>(&mut types, "RpcResponse");
    add::<RpcNotification>(&mut types, "RpcNotification");
    add::<RpcError>(&mut types, "RpcError");
    add::<ThreadEvent>(&mut types, "ThreadEvent");
    add::<EventNotification>(&mut types, "EventNotification");
    add::<Thread>(&mut types, "Thread");
    add::<Project>(&mut types, "Project");
    add::<TranscriptEntry>(&mut types, "TranscriptEntry");
    add::<ApprovalRequest>(&mut types, "ApprovalRequest");
    add::<ProviderStatus>(&mut types, "ProviderStatus");
    add::<Scope>(&mut types, "Scope");
    add::<Checkpoint>(&mut types, "Checkpoint");
    add::<Diff>(&mut types, "Diff");
    add::<Settings>(&mut types, "Settings");
    add::<PairRequest>(&mut types, "PairRequest");
    add::<PairResponse>(&mut types, "PairResponse");
    add::<AssetInfo>(&mut types, "AssetInfo");
    add::<SkillInfo>(&mut types, "SkillInfo");
    add::<PullRequest>(&mut types, "PullRequest");
    add::<TerminalOutputNotification>(&mut types, "TerminalOutputNotification");
    add::<TerminalExitedNotification>(&mut types, "TerminalExitedNotification");
    add::<RuntimeTask>(&mut types, "RuntimeTask");
    add::<ThreadActivitySummary>(&mut types, "ThreadActivitySummary");

    let mut methods = Vec::new();
    method::<DaemonInfoMethod>(&mut methods);
    method::<DaemonShutdown>(&mut methods);
    method::<DaemonActivityMethod>(&mut methods);
    method::<ProvidersList>(&mut methods);
    method::<HarnessUpdatesList>(&mut methods);
    method::<HarnessUpdatesRun>(&mut methods);
    method::<DaemonUpdateStatusMethod>(&mut methods);
    method::<DaemonUpdateCheck>(&mut methods);
    method::<DaemonUpdateRun>(&mut methods);
    method::<ProjectsList>(&mut methods);
    method::<ProjectsBrowse>(&mut methods);
    method::<ProjectsAdd>(&mut methods);
    method::<ProjectsUpdate>(&mut methods);
    method::<ProjectsRemove>(&mut methods);
    method::<ThreadsList>(&mut methods);
    method::<ThreadsCreate>(&mut methods);
    method::<ThreadsGet>(&mut methods);
    method::<ThreadsUpdate>(&mut methods);
    method::<ThreadsArchive>(&mut methods);
    method::<ThreadsSend>(&mut methods);
    method::<QueueAdd>(&mut methods);
    method::<QueueList>(&mut methods);
    method::<QueueRemove>(&mut methods);
    method::<ThreadsRelease>(&mut methods);
    method::<ThreadsCompact>(&mut methods);
    method::<ThreadsAnswer>(&mut methods);
    method::<ThreadsInterrupt>(&mut methods);
    method::<TasksList>(&mut methods);
    method::<TaskStop>(&mut methods);
    method::<TaskBackground>(&mut methods);
    method::<ThreadsRegenerateTitle>(&mut methods);
    method::<ThreadsCheckpoints>(&mut methods);
    method::<ThreadsDiff>(&mut methods);
    method::<ThreadsRevert>(&mut methods);
    method::<TerminalsCreate>(&mut methods);
    method::<TerminalsList>(&mut methods);
    method::<TerminalsInput>(&mut methods);
    method::<TerminalsResize>(&mut methods);
    method::<TerminalsClose>(&mut methods);
    method::<TerminalsSubscribe>(&mut methods);
    method::<TerminalsUnsubscribe>(&mut methods);
    method::<SettingsGet>(&mut methods);
    method::<SettingsUpdate>(&mut methods);
    method::<UsageSummary>(&mut methods);
    method::<PairingCreate>(&mut methods);
    method::<ExposureGet>(&mut methods);
    method::<ExposureSet>(&mut methods);
    method::<TokensList>(&mut methods);
    method::<TokensRevoke>(&mut methods);
    method::<GitStatusMethod>(&mut methods);
    method::<GitBranches>(&mut methods);
    method::<GitCommit>(&mut methods);
    method::<PrCreate>(&mut methods);
    method::<PrList>(&mut methods);
    method::<FilesSearch>(&mut methods);
    method::<FilesList>(&mut methods);
    method::<FilesRead>(&mut methods);
    method::<SkillsList>(&mut methods);
    method::<ApprovalsRespond>(&mut methods);
    method::<ApprovalsList>(&mut methods);
    method::<EventsSubscribe>(&mut methods);
    method::<EventsUnsubscribe>(&mut methods);
    method::<EventsRange>(&mut methods);

    let doc = json!({
        "protocol_version": PROTOCOL_VERSION,
        "event_notification": EVENT_NOTIFICATION,
        "types": types,
        "methods": methods,
    });

    let out = serde_json::to_string_pretty(&doc).unwrap();
    match std::env::args().nth(1) {
        Some(dir) => {
            std::fs::create_dir_all(&dir).unwrap();
            let path = std::path::Path::new(&dir).join("kybern-protocol.schema.json");
            std::fs::write(&path, out).unwrap();
            eprintln!("wrote {}", path.display());
        }
        None => println!("{out}"),
    }
}
