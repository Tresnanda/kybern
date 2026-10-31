//! GitHub Actions through the user's `gh` (ADE-97): workflow runs on every branch, a run's jobs and
//! steps, job logs read a page at a time, reruns, cancel and `workflow_dispatch`.
//!
//! A finished job's log never changes, so it is streamed once from `gh api` into a file under the
//! data folder's cache and pages are read from there: neither the daemon nor a client ever holds a
//! whole log. A sparse line index (every `CHECKPOINT` lines) keeps a page read short.
use kybern_protocol::process::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, anyhow, ensure};
use kybern_protocol::methods::*;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::github::run;

/// A line longer than this is cut (minified bundles, base64 dumps).
const LINE_BYTES: usize = 4 * 1024;
const CHECKPOINT: u32 = 512;
const MAX_PAGE: u32 = 2000;
/// Cached job logs kept on disk; older ones are removed when a new one arrives.
const CACHED_LOGS: usize = 24;
/// The excerpt for an agent: at most this many lines and bytes, ending at the last error.
const EXCERPT_LINES: usize = 100;
const EXCERPT_BYTES: usize = 12 * 1024;
const MAX_ERROR_LINES: usize = 50;

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}
fn opt_text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}
fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or_default()
}

/// `gh`'s failure in words that say what to do next; the original text follows for the details.
pub(crate) fn friendly(error: anyhow::Error) -> anyhow::Error {
    let raw = format!("{error:#}");
    let lower = raw.to_ascii_lowercase();
    let lead = if lower.contains("program not found") || lower.contains("no such file") || lower.contains("run gh:") {
        "The GitHub CLI (gh) isn't installed. Install it from cli.github.com, run gh auth login, and try again."
    } else if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("http 401") {
        "gh isn't signed in. Run gh auth login and try again."
    } else if lower.contains("workflow_dispatch") {
        "This workflow can't be started by hand: its file has no workflow_dispatch trigger on that branch."
    } else if lower.contains("http 403") {
        "GitHub refused this: the signed-in gh account can't do it in this repository. Check its access and try again."
    } else if lower.contains("http 404") {
        "GitHub couldn't find this. Check that origin points at GitHub and that the gh account can see the repository."
    } else if lower.contains("none of the git remotes") || lower.contains("no git remotes") || lower.contains("not a git repository") {
        "This project has no GitHub remote. Add one, then try again."
    } else {
        return error;
    };
    anyhow!("{lead} ({})", raw.lines().last().unwrap_or_default().trim())
}

/// A workflow id, or a file name such as `ci.yml`: the only forms GitHub's workflow routes take.
fn validate_workflow(workflow: &str) -> Result<&str> {
    let ok = !workflow.is_empty()
        && workflow.len() <= 200
        && workflow.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !workflow.starts_with(['.', '-']);
    ensure!(ok, "Choose a workflow by its id or file name, such as ci.yml.");
    Ok(workflow)
}

/// A query value: unreserved characters as they are, the rest percent-encoded.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn parse_run(v: &Value) -> Option<WorkflowRun> {
    let id = v.get("id")?.as_u64()?;
    let actor = v.pointer("/triggering_actor/login").or_else(|| v.pointer("/actor/login")).and_then(Value::as_str).unwrap_or_default();
    Some(WorkflowRun {
        id,
        number: num(v, "run_number"),
        attempt: v.get("run_attempt").and_then(Value::as_u64).unwrap_or(1) as u32,
        workflow_name: text(v, "name"),
        workflow_id: num(v, "workflow_id"),
        workflow_path: text(v, "path").split('@').next().unwrap_or_default().to_owned(),
        title: opt_text(v, "display_title").unwrap_or_else(|| text(v, "name")),
        head_branch: text(v, "head_branch"),
        head_sha: text(v, "head_sha"),
        event: text(v, "event"),
        status: text(v, "status"),
        conclusion: text(v, "conclusion"),
        url: text(v, "html_url"),
        created_at: text(v, "created_at"),
        started_at: opt_text(v, "run_started_at"),
        updated_at: text(v, "updated_at"),
        actor: actor.to_owned(),
        pull_requests: v
            .get("pull_requests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|pr| pr.get("number").and_then(Value::as_u64))
            .collect(),
    })
}

pub(crate) fn parse_runs(v: &Value, page: u32, per_page: u32) -> ActionsRunsResult {
    let runs: Vec<WorkflowRun> = v.get("workflow_runs").and_then(Value::as_array).into_iter().flatten().filter_map(parse_run).collect();
    let total_count = num(v, "total_count");
    ActionsRunsResult {
        has_more: u64::from(page) * u64::from(per_page) < total_count && !runs.is_empty(),
        runs,
        total_count,
        page,
        viewer: None,
    }
}

pub(crate) fn parse_job(v: &Value) -> Option<WorkflowJob> {
    Some(WorkflowJob {
        id: v.get("id")?.as_u64()?,
        name: text(v, "name"),
        status: text(v, "status"),
        conclusion: text(v, "conclusion"),
        started_at: opt_text(v, "started_at"),
        completed_at: opt_text(v, "completed_at"),
        url: text(v, "html_url"),
        labels: v.get("labels").and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.as_str().map(str::to_owned)).collect(),
        steps: v
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|s| WorkflowStep {
                number: num(s, "number") as u32,
                name: text(s, "name"),
                status: text(s, "status"),
                conclusion: text(s, "conclusion"),
                started_at: opt_text(s, "started_at"),
                completed_at: opt_text(s, "completed_at"),
            })
            .collect(),
    })
}

pub(crate) fn parse_workflows(v: &Value) -> Vec<Workflow> {
    v.get("workflows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| {
            Some(Workflow { id: w.get("id")?.as_u64()?, name: text(w, "name"), path: text(w, "path"), state: text(w, "state") })
        })
        .collect()
}

async fn api(gh: &str, cwd: &Path, endpoint: &str) -> Result<Value> {
    let out = run(cwd, gh, &["api", "-H", "Accept: application/vnd.github+json", endpoint]).await?;
    serde_json::from_str(&out).with_context(|| format!("read gh api {endpoint}"))
}

/// The signed-in account, asked once per `gh` program and kept while it answers.
async fn viewer(gh: &str, cwd: &Path) -> Option<String> {
    static VIEWERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = VIEWERS.get_or_init(Default::default);
    if let Some(login) = cache.lock().ok()?.get(gh) {
        return Some(login.clone());
    }
    let login = run(cwd, gh, &["api", "user", "-q", ".login"]).await.ok().filter(|s| !s.trim().is_empty())?;
    cache.lock().ok()?.insert(gh.to_owned(), login.trim().to_owned());
    Some(login.trim().to_owned())
}

pub async fn runs(gh: &str, cwd: &Path, p: &ActionsRunsParams) -> Result<ActionsRunsResult> {
    let per_page = p.per_page.clamp(1, 100);
    let page = p.page.max(1);
    let mut endpoint = match p.workflow.as_deref().filter(|w| !w.is_empty()) {
        Some(w) => format!("repos/{{owner}}/{{repo}}/actions/workflows/{}/runs", validate_workflow(w)?),
        None => "repos/{owner}/{repo}/actions/runs".to_owned(),
    };
    endpoint.push_str(&format!("?per_page={per_page}&page={page}"));
    for (key, value) in [("branch", &p.branch), ("status", &p.status), ("event", &p.event)] {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            endpoint.push_str(&format!("&{key}={}", encode(value)));
        }
    }
    let (listed, viewer) = tokio::join!(api(gh, cwd, &endpoint), viewer(gh, cwd));
    let mut result = parse_runs(&listed.map_err(friendly)?, page, per_page);
    result.viewer = viewer;
    Ok(result)
}

pub async fn run_detail(gh: &str, cwd: &Path, run_id: u64) -> Result<ActionsRunResult> {
    ensure!(run_id > 0, "Choose a workflow run.");
    let (run_endpoint, jobs_endpoint) = (
        format!("repos/{{owner}}/{{repo}}/actions/runs/{run_id}"),
        format!("repos/{{owner}}/{{repo}}/actions/runs/{run_id}/jobs?per_page=100&filter=latest"),
    );
    let (run, jobs) = tokio::join!(api(gh, cwd, &run_endpoint), api(gh, cwd, &jobs_endpoint));
    let run = parse_run(&run.map_err(friendly)?).ok_or_else(|| anyhow!("GitHub returned no workflow run {run_id}."))?;
    let jobs = jobs.map_err(friendly)?.get("jobs").and_then(Value::as_array).into_iter().flatten().filter_map(parse_job).collect();
    Ok(ActionsRunResult { run, jobs })
}

pub async fn workflows(gh: &str, cwd: &Path) -> Result<ActionsWorkflowsResult> {
    let (listed, default_branch) =
        tokio::join!(api(gh, cwd, "repos/{owner}/{repo}/actions/workflows?per_page=100"), crate::github::default_base_with(gh, cwd));
    Ok(ActionsWorkflowsResult { workflows: parse_workflows(&listed.map_err(friendly)?), default_branch })
}

pub async fn workflow(gh: &str, cwd: &Path, p: &ActionsWorkflowParams) -> Result<ActionsWorkflowResult> {
    let workflow = validate_workflow(&p.workflow)?;
    let mut args = vec!["workflow", "view", workflow, "--yaml"];
    if let Some(r) = p.git_ref.as_deref().filter(|r| !r.is_empty()) {
        args.extend(["--ref", r]);
    }
    let yaml = run(cwd, gh, &args).await.map_err(friendly)?;
    Ok(parse_dispatch(&yaml))
}

pub async fn action(gh: &str, cwd: &Path, p: &ActionsActionParams) -> Result<()> {
    ensure!(p.run_id > 0, "Choose a workflow run.");
    let id = p.run_id.to_string();
    let job = p.job_id.map(|j| j.to_string());
    let args: Vec<&str> = match p.action {
        ActionsActionKind::Rerun => vec!["run", "rerun", &id],
        ActionsActionKind::RerunFailed => vec!["run", "rerun", &id, "--failed"],
        ActionsActionKind::RerunJob => {
            vec!["run", "rerun", "--job", job.as_deref().ok_or_else(|| anyhow!("Choose the job to run again."))?]
        }
        ActionsActionKind::Cancel => vec!["run", "cancel", &id],
    };
    run(cwd, gh, &args).await.map_err(friendly).map(|_| ())
}

pub async fn dispatch(gh: &str, cwd: &Path, p: &ActionsDispatchParams) -> Result<()> {
    let workflow = validate_workflow(&p.workflow)?;
    ensure!(!p.git_ref.trim().is_empty() && !p.git_ref.starts_with('-'), "Choose the branch or tag to run on.");
    let fields: Vec<String> = p
        .inputs
        .iter()
        .map(|(name, value)| {
            ensure!(!name.is_empty() && !name.contains('=') && !name.starts_with('-'), "Input names can't be empty or contain “=”.");
            Ok(format!("{name}={value}"))
        })
        .collect::<Result<_>>()?;
    let mut args = vec!["workflow", "run", workflow, "--ref", p.git_ref.as_str()];
    for field in &fields {
        args.extend(["-f", field.as_str()]);
    }
    run(cwd, gh, &args).await.map_err(friendly).map(|_| ())
}

// ---- workflow_dispatch inputs ----

/// Indentation and content of a YAML line, without its comment; None for blank and comment lines.
fn yaml_line(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let indent = line.len() - trimmed.len();
    let mut quote = None;
    let mut end = trimmed.len();
    for (i, c) in trimmed.char_indices() {
        match (quote, c) {
            (None, '\'' | '"') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '#') if i > 0 && trimmed[..i].ends_with(' ') => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    Some((indent, trimmed[..end].trim_end()))
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        return v[1..v.len() - 1].to_owned();
    }
    v.to_owned()
}

fn key_value(content: &str) -> Option<(String, String)> {
    let content = content.strip_prefix("- ").unwrap_or(content);
    let (key, value) = content.split_once(':').filter(|(k, v)| !k.is_empty() && (v.is_empty() || v.starts_with(' ')))?;
    Some((unquote(key), value.trim().to_owned()))
}

/// `workflow_dispatch` and its inputs from a workflow file: the subset of YAML that workflow files
/// use for it (block mappings, inline lists of choices, `on: [push, workflow_dispatch]`).
pub(crate) fn parse_dispatch(yaml: &str) -> ActionsWorkflowResult {
    let lines: Vec<(usize, &str)> = yaml.lines().filter_map(yaml_line).collect();
    let mut result = ActionsWorkflowResult { dispatchable: false, inputs: Vec::new() };
    // The top-level `on:` (YAML 1.1 readers also call it `true`).
    let Some(on) = lines.iter().position(|(indent, c)| *indent == 0 && key_value(c).is_some_and(|(k, _)| k == "on" || k == "true")) else {
        return result;
    };
    let (_, on_value) = key_value(lines[on].1).unwrap_or_default();
    if !on_value.is_empty() {
        result.dispatchable = on_value.contains("workflow_dispatch");
        return result;
    }
    let block = |start: usize, parent: usize| lines[start..].iter().take_while(move |(indent, _)| *indent > parent).copied();
    let on_lines: Vec<(usize, &str)> = block(on + 1, 0).collect();
    let Some(child_indent) = on_lines.first().map(|(i, _)| *i) else { return result };
    // `on:` followed by a list (`- push`) or a mapping.
    if on_lines.iter().any(|(i, c)| *i == child_indent && c.trim_start_matches("- ").trim() == "workflow_dispatch" && c.starts_with("- ")) {
        result.dispatchable = true;
        return result;
    }
    let Some(at) = on_lines.iter().position(|(i, c)| *i == child_indent && key_value(c).is_some_and(|(k, _)| k == "workflow_dispatch"))
    else {
        return result;
    };
    result.dispatchable = true;
    let dispatch: Vec<(usize, &str)> = on_lines[at + 1..].iter().take_while(|(i, _)| *i > child_indent).copied().collect();
    let Some(inputs_at) = dispatch.iter().position(|(_, c)| key_value(c).is_some_and(|(k, _)| k == "inputs")) else { return result };
    let inputs_indent = dispatch[inputs_at].0;
    let inputs: Vec<(usize, &str)> = dispatch[inputs_at + 1..].iter().take_while(|(i, _)| *i > inputs_indent).copied().collect();
    let Some(name_indent) = inputs.first().map(|(i, _)| *i) else { return result };
    let mut current: Option<WorkflowInput> = None;
    let mut in_options = false;
    for (indent, content) in inputs {
        if indent == name_indent {
            result.inputs.extend(current.take());
            if let Some((name, _)) = key_value(content) {
                current = Some(WorkflowInput { name, kind: "string".into(), ..Default::default() });
            }
            in_options = false;
            continue;
        }
        let Some(input) = current.as_mut() else { continue };
        if in_options && content.starts_with("- ") {
            input.options.push(unquote(&content[2..]));
            continue;
        }
        in_options = false;
        let Some((key, value)) = key_value(content) else { continue };
        match key.as_str() {
            "description" => input.description = unquote(&value),
            "required" => input.required = value == "true",
            "default" => input.default = unquote(&value),
            "type" => input.kind = unquote(&value),
            "options" if value.starts_with('[') => {
                input.options = value.trim_matches(['[', ']']).split(',').map(unquote).filter(|s| !s.is_empty()).collect();
            }
            "options" => in_options = true,
            _ => {}
        }
    }
    result.inputs.extend(current);
    result
}

// ---- job logs ----

/// What the daemon knows about one cached log without reading it.
#[derive(Debug, Clone, Default)]
struct LogIndex {
    total_lines: u32,
    error_lines: Vec<u32>,
    /// Byte offset of line `CHECKPOINT * i`.
    checkpoints: Vec<u64>,
    clipped: bool,
}

fn indexes() -> &'static Mutex<HashMap<PathBuf, LogIndex>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, LogIndex>>> = OnceLock::new();
    INDEXES.get_or_init(Default::default)
}

/// One raw log line as it is stored: without GitHub's timestamp and the byte-order mark, bounded.
pub(crate) fn clean_line(raw: &str) -> (String, bool) {
    let line = raw.trim_end_matches(['\n', '\r']).trim_start_matches('\u{feff}');
    // `2026-10-31T15:37:57.1234567Z text`
    let line = match line.split_once(' ') {
        Some((stamp, rest))
            if stamp.len() >= 20
                && stamp.ends_with('Z')
                && stamp.as_bytes().get(10) == Some(&b'T')
                && stamp.as_bytes()[..4].iter().all(u8::is_ascii_digit) =>
        {
            rest
        }
        _ if line.len() >= 20 && line.ends_with('Z') && line.as_bytes().get(10) == Some(&b'T') => "",
        _ => line,
    };
    if line.len() <= LINE_BYTES {
        return (line.to_owned(), false);
    }
    let mut end = LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &line[..end]), true)
}

fn is_error(line: &str) -> bool {
    line.starts_with("##[error]")
}

/// Stream `reader` (the raw log) into `path`, cleaning each line, and index it.
async fn store_log(mut reader: impl tokio::io::AsyncBufRead + Unpin, path: &Path) -> Result<LogIndex> {
    let partial = path.with_extension("part");
    let mut out = tokio::io::BufWriter::new(tokio::fs::File::create(&partial).await.context("create log cache")?);
    let mut index = LogIndex::default();
    let mut offset = 0u64;
    let mut raw = Vec::new();
    loop {
        raw.clear();
        if reader.read_until(b'\n', &mut raw).await? == 0 {
            break;
        }
        let (line, clipped) = clean_line(&String::from_utf8_lossy(&raw));
        if index.total_lines % CHECKPOINT == 0 {
            index.checkpoints.push(offset);
        }
        if is_error(&line) && index.error_lines.len() < MAX_ERROR_LINES {
            index.error_lines.push(index.total_lines);
        }
        index.clipped |= clipped;
        out.write_all(line.as_bytes()).await?;
        out.write_all(b"\n").await?;
        offset += line.len() as u64 + 1;
        index.total_lines += 1;
    }
    out.flush().await?;
    drop(out);
    tokio::fs::rename(&partial, path).await.context("keep log cache")?;
    Ok(index)
}

/// The index of a log already on disk (a daemon restart forgets them).
async fn index_file(path: &Path) -> Result<LogIndex> {
    let mut reader = BufReader::new(tokio::fs::File::open(path).await?);
    let mut index = LogIndex::default();
    let mut offset = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).await?;
        if n == 0 {
            break;
        }
        if index.total_lines % CHECKPOINT == 0 {
            index.checkpoints.push(offset);
        }
        if line.starts_with(b"##[error]") && index.error_lines.len() < MAX_ERROR_LINES {
            index.error_lines.push(index.total_lines);
        }
        index.clipped |= line.ends_with("…\n".as_bytes()) && n > LINE_BYTES;
        offset += n as u64;
        index.total_lines += 1;
    }
    Ok(index)
}

/// Lines `[offset, offset + limit)` of a stored log.
async fn read_lines(path: &Path, index: &LogIndex, offset: u32, limit: u32) -> Result<Vec<String>> {
    if offset >= index.total_lines {
        return Ok(Vec::new());
    }
    let checkpoint = (offset / CHECKPOINT) as usize;
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(index.checkpoints.get(checkpoint).copied().unwrap_or(0))).await?;
    let mut reader = BufReader::new(file);
    let mut skip = offset - checkpoint as u32 * CHECKPOINT;
    let mut lines = Vec::with_capacity(limit.min(index.total_lines - offset) as usize);
    let mut buf = Vec::new();
    while lines.len() < limit as usize {
        buf.clear();
        if reader.read_until(b'\n', &mut buf).await? == 0 {
            break;
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }
        lines.push(String::from_utf8_lossy(buf.strip_suffix(b"\n").unwrap_or(&buf)).into_owned());
    }
    Ok(lines)
}

/// Where the failure is: the lines before the last error, or the tail when nothing was marked.
pub(crate) fn excerpt_range(index_total: u32, errors: &[u32]) -> (u32, u32) {
    let end = errors.last().map(|e| e + 1).unwrap_or(index_total).min(index_total);
    (end.saturating_sub(EXCERPT_LINES as u32), end)
}

/// Drop leading lines until the excerpt fits `EXCERPT_BYTES`.
pub(crate) fn bound_excerpt(mut lines: Vec<String>, mut offset: u32) -> (Vec<String>, u32) {
    let mut bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
    let mut drop = 0;
    while bytes > EXCERPT_BYTES && drop < lines.len() {
        bytes -= lines[drop].len() + 1;
        drop += 1;
    }
    lines.drain(..drop);
    offset += drop as u32;
    (lines, offset)
}

/// Remove the oldest cached logs beyond `CACHED_LOGS`.
async fn prune(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    let mut logs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Ok(meta) = entry.metadata().await {
            logs.push((meta.modified().ok(), entry.path()));
        }
    }
    if logs.len() <= CACHED_LOGS {
        return;
    }
    logs.sort();
    let excess = logs.len() - CACHED_LOGS;
    for (_, path) in logs.into_iter().take(excess) {
        if let Ok(mut map) = indexes().lock() {
            map.remove(&path);
        }
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// Download one finished job's log into `path`, streaming `gh`'s output.
async fn download(gh: &str, cwd: &Path, job_id: u64, path: &Path) -> Result<LogIndex> {
    let mut child = Command::new(gh)
        .no_window()
        .current_dir(cwd)
        .args(["api", &format!("repos/{{owner}}/{{repo}}/actions/jobs/{job_id}/logs")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("run {gh}"))?;
    let stdout = child.stdout.take().context("gh stdout")?;
    let mut stderr = child.stderr.take().context("gh stderr")?;
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        let _ = (&mut stderr).take(16 * 1024).read_to_string(&mut text).await;
        text
    });
    let stored = store_log(BufReader::new(stdout), path).await;
    let status = child.wait().await?;
    let stderr = errors.await.unwrap_or_default();
    if !status.success() {
        let _ = tokio::fs::remove_file(path).await;
        let _ = tokio::fs::remove_file(path.with_extension("part")).await;
        return Err(anyhow!("{gh} api job {job_id} logs: {}", stderr.trim()));
    }
    stored
}

pub async fn log(gh: &str, cwd: &Path, cache: &Path, p: &ActionsLogParams) -> Result<ActionsLogResult> {
    ensure!(p.job_id > 0, "Choose a job.");
    let path = cache.join(format!("{}.log", p.job_id));
    let known = indexes().lock().ok().and_then(|m| m.get(&path).cloned());
    let index = match known {
        Some(index) if path.exists() => index,
        _ if path.exists() => index_file(&path).await?,
        _ => {
            let job = api(gh, cwd, &format!("repos/{{owner}}/{{repo}}/actions/jobs/{}", p.job_id)).await.map_err(friendly)?;
            if text(&job, "status") != "completed" {
                return Ok(ActionsLogResult {
                    available: false,
                    lines: Vec::new(),
                    offset: 0,
                    total_lines: 0,
                    error_lines: Vec::new(),
                    clipped: false,
                });
            }
            tokio::fs::create_dir_all(cache).await.context("create log cache")?;
            let index = download(gh, cwd, p.job_id, &path).await.map_err(friendly)?;
            prune(cache).await;
            index
        }
    };
    if let Ok(mut map) = indexes().lock() {
        if map.len() > CACHED_LOGS * 2 {
            map.clear();
        }
        map.insert(path.clone(), index.clone());
    }
    let (lines, offset) = if p.excerpt {
        let (start, end) = excerpt_range(index.total_lines, &index.error_lines);
        bound_excerpt(read_lines(&path, &index, start, end - start).await?, start)
    } else {
        let offset = p.offset.min(index.total_lines);
        (read_lines(&path, &index, offset, p.limit.clamp(1, MAX_PAGE)).await?, offset)
    };
    Ok(ActionsLogResult {
        available: true,
        lines,
        offset,
        total_lines: index.total_lines,
        error_lines: index.error_lines,
        clipped: index.clipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run_json(id: u64, status: &str, conclusion: Option<&str>) -> Value {
        json!({
            "id": id, "run_number": 695, "run_attempt": 2, "name": "CI", "display_title": "Fix the importer",
            "workflow_id": 349107759, "path": ".github/workflows/ci.yml@refs/heads/main",
            "head_branch": "main", "head_sha": "356376d", "event": "push", "status": status, "conclusion": conclusion,
            "html_url": format!("https://github.com/o/r/actions/runs/{id}"), "created_at": "2026-10-31T15:37:44Z",
            "run_started_at": "2026-10-31T15:37:44Z", "updated_at": "2026-10-31T15:39:06Z",
            "actor": {"login": "ana"}, "triggering_actor": {"login": "kevin"},
            "pull_requests": [{"number": 168}],
        })
    }

    #[test]
    fn runs_read_every_field_and_know_when_more_follow() {
        let listed = json!({"total_count": 61, "workflow_runs": [run_json(1, "completed", Some("failure")), run_json(2, "in_progress", None), {"no": "id"}]});
        let result = parse_runs(&listed, 2, 30);
        assert_eq!(result.runs.len(), 2);
        assert!(result.has_more, "60 of 61 read");
        let first = &result.runs[0];
        assert_eq!((first.number, first.attempt, first.workflow_name.as_str()), (695, 2, "CI"));
        assert_eq!(first.workflow_path, ".github/workflows/ci.yml");
        assert_eq!(first.actor, "kevin", "the rerun's actor, not the push's");
        assert_eq!(first.pull_requests, vec![168]);
        assert_eq!(first.conclusion, "failure");
        assert_eq!(result.runs[1].conclusion, "", "null while running");
        assert!(!parse_runs(&listed, 3, 30).has_more);
        assert!(!parse_runs(&json!({"total_count": 5, "workflow_runs": []}), 1, 30).has_more);
    }

    #[test]
    fn jobs_carry_their_steps() {
        let job = parse_job(&json!({
            "id": 9, "name": "test (macos)", "status": "completed", "conclusion": "failure", "html_url": "u",
            "labels": ["macos-latest"], "started_at": "2026-10-31T15:37:50Z", "completed_at": null,
            "steps": [{"number": 1, "name": "Set up job", "status": "completed", "conclusion": "success"},
                      {"number": 4, "name": "cargo test", "status": "completed", "conclusion": "failure", "started_at": "a", "completed_at": "b"}],
        }))
        .unwrap();
        assert_eq!(job.labels, vec!["macos-latest"]);
        assert_eq!(job.completed_at, None);
        assert_eq!(job.steps[1].name, "cargo test");
        assert_eq!(job.steps[1].conclusion, "failure");
    }

    #[test]
    fn workflows_list_and_names_are_validated() {
        let w = parse_workflows(&json!({"workflows": [{"id": 1, "name": "CI", "path": ".github/workflows/ci.yml", "state": "active"}]}));
        assert_eq!((w[0].id, w[0].path.as_str()), (1, ".github/workflows/ci.yml"));
        assert!(validate_workflow("gpuix-platforms.yml").is_ok());
        assert!(validate_workflow("349107759").is_ok());
        for bad in ["", "../x", "a/b.yml", "-f", ".hidden", "ci yml"] {
            assert!(validate_workflow(bad).is_err(), "{bad}");
        }
        assert_eq!(encode("feat/x y"), "feat%2Fx%20y");
    }

    #[test]
    fn errors_say_what_to_do_next() {
        let auth = friendly(anyhow!("gh api x: To get started with GitHub CLI, please run:  gh auth login")).to_string();
        assert!(auth.starts_with("gh isn't signed in. Run gh auth login and try again."), "{auth}");
        let missing = friendly(anyhow!("run gh: program not found")).to_string();
        assert!(missing.contains("isn't installed"), "{missing}");
        let dispatch = friendly(anyhow!("HTTP 422: Workflow does not have 'workflow_dispatch' trigger")).to_string();
        assert!(dispatch.contains("can't be started by hand"), "{dispatch}");
        assert_eq!(friendly(anyhow!("something else")).to_string(), "something else");
    }

    #[test]
    fn dispatch_inputs_from_a_block_mapping() {
        let yaml = r#"
name: GPUIX platforms
on:
  push:
    branches: [main]
  workflow_dispatch:   # by hand
    inputs:
      checks:
        description: "Checks to run: all, or a comma list"
        required: true
        default: all
      platform:
        type: choice
        options:
          - windows
          - 'linux # x11'
        default: windows
      verbose:
        type: boolean
      level: { }
      targets:
        type: choice
        options: [a, "b", c]
jobs:
  build:
    runs-on: ubuntu-latest
"#;
        let r = parse_dispatch(yaml);
        assert!(r.dispatchable);
        let names: Vec<_> = r.inputs.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["checks", "platform", "verbose", "level", "targets"]);
        assert_eq!(
            r.inputs[0],
            WorkflowInput {
                name: "checks".into(),
                description: "Checks to run: all, or a comma list".into(),
                required: true,
                default: "all".into(),
                kind: "string".into(),
                options: vec![]
            }
        );
        assert_eq!(r.inputs[1].options, ["windows", "linux # x11"]);
        assert_eq!(r.inputs[1].default, "windows");
        assert_eq!(r.inputs[2].kind, "boolean");
        assert_eq!(r.inputs[4].options, ["a", "b", "c"]);
    }

    #[test]
    fn dispatch_without_inputs_and_other_trigger_forms() {
        assert!(parse_dispatch("on:\n  workflow_dispatch:\njobs: {}\n").dispatchable);
        assert!(parse_dispatch("on: [push, workflow_dispatch]\n").dispatchable);
        assert!(parse_dispatch("on:\n  - push\n  - workflow_dispatch\n").dispatchable);
        assert!(parse_dispatch("\"on\":\n  workflow_dispatch: {}\n").dispatchable);
        assert!(!parse_dispatch("on: push\n").dispatchable);
        assert!(!parse_dispatch("on:\n  push:\n    branches: [main]\njobs:\n  workflow_dispatch:\n").dispatchable);
        assert!(parse_dispatch("on:\n  workflow_dispatch:\n").inputs.is_empty());
    }

    #[test]
    fn log_lines_lose_timestamps_and_stay_bounded() {
        assert_eq!(clean_line("\u{feff}2026-10-31T15:37:57.1234567Z ##[group]Run cargo test\n").0, "##[group]Run cargo test");
        assert_eq!(clean_line("2026-10-31T15:37:57.1234567Z\n").0, "");
        assert_eq!(clean_line("plain text").0, "plain text");
        let (long, clipped) = clean_line(&"é".repeat(LINE_BYTES));
        assert!(clipped && long.len() <= LINE_BYTES + "…".len());
    }

    #[test]
    fn excerpts_end_at_the_last_error_and_fit_the_budget() {
        assert_eq!(excerpt_range(1000, &[400, 950]), (851, 951));
        assert_eq!(excerpt_range(30, &[]), (0, 30));
        assert_eq!(excerpt_range(5000, &[]), (4900, 5000));
        let (lines, offset) = bound_excerpt(vec!["x".repeat(1000); 20], 10);
        assert!(lines.iter().map(|l| l.len() + 1).sum::<usize>() <= EXCERPT_BYTES);
        assert_eq!(offset as usize, 10 + 20 - lines.len());
    }

    #[tokio::test]
    async fn stored_logs_page_from_any_offset() {
        let dir = std::env::temp_dir().join(format!("kybern-actions-log-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("7.log");
        let mut raw = String::new();
        for i in 0..1300u32 {
            if i == 1200 {
                raw.push_str("2026-10-31T15:37:57.1234567Z ##[error]Process completed with exit code 1.\n");
            } else {
                raw.push_str(&format!("2026-10-31T15:37:57.1234567Z line {i}\n"));
            }
        }
        let index = store_log(BufReader::new(raw.as_bytes()), &path).await.unwrap();
        assert_eq!(index.total_lines, 1300);
        assert_eq!(index.error_lines, vec![1200]);
        assert_eq!(index.checkpoints.len(), 3);
        let page = read_lines(&path, &index, 510, 4).await.unwrap();
        assert_eq!(page, ["line 510", "line 511", "line 512", "line 513"]);
        assert_eq!(read_lines(&path, &index, 1298, 10).await.unwrap(), ["line 1298", "line 1299"]);
        assert!(read_lines(&path, &index, 1300, 10).await.unwrap().is_empty());
        let reread = index_file(&path).await.unwrap();
        assert_eq!((reread.total_lines, reread.error_lines.clone(), reread.checkpoints.clone()), (1300, vec![1200], index.checkpoints));
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod rpc_tests {
    use kybern_protocol::methods::*;
    use serde_json::{Value, json};

    /// A fake `gh` that logs its arguments and answers the Actions routes this module calls.
    fn fake_gh(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let log = dir.join("gh.log");
        let run = r#"{"id":5,"run_number":12,"run_attempt":1,"name":"CI","display_title":"Fix","workflow_id":3,"path":".github/workflows/ci.yml","head_branch":"main","head_sha":"abc","event":"push","status":"completed","conclusion":"failure","html_url":"https://github.com/o/r/actions/runs/5","created_at":"2026-10-31T00:00:00Z","updated_at":"2026-10-31T00:01:00Z","triggering_actor":{"login":"ana"}}"#;
        let unix = format!(
            r#"#!/bin/sh
echo "$@" >> "{log}"
case "$*" in
  "api user -q .login") echo ana ;;
  *"actions/runs?"*) echo '{{"total_count":1,"workflow_runs":[{run}]}}' ;;
  *"actions/runs/5/jobs"*) echo '{{"jobs":[{{"id":9,"name":"test","status":"completed","conclusion":"failure","html_url":"u","steps":[{{"number":1,"name":"cargo test","status":"completed","conclusion":"failure"}}]}}]}}' ;;
  *"actions/runs/5") echo '{run}' ;;
  *"actions/jobs/9/logs") printf '2026-10-31T00:00:00.0000000Z one\n2026-10-31T00:00:00.0000000Z ##[error]boom\n2026-10-31T00:00:00.0000000Z three\n' ;;
  *"actions/jobs/9") echo '{{"id":9,"status":"completed"}}' ;;
  *"actions/jobs/10") echo '{{"id":10,"status":"in_progress"}}' ;;
  *"actions/workflows?"*) echo '{{"workflows":[{{"id":3,"name":"CI","path":".github/workflows/ci.yml","state":"active"}}]}}' ;;
  "repo view"*) echo main ;;
  "workflow view ci.yml --yaml"*) printf 'on:\n  workflow_dispatch:\n    inputs:\n      checks:\n        default: all\n' ;;
  "run rerun"*|"run cancel"*|"workflow run"*) ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
"#,
            log = log.display(),
        );
        (crate::test_support::script(dir, "gh", &unix, ""), log)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actions_methods_run_gh_in_the_project() {
        let root = std::env::temp_dir().join(format!("kybern-actions-rpc-{}", uuid::Uuid::now_v7()));
        let paths = crate::config::Paths::resolve(Some(root.join("data"))).unwrap();
        let state = crate::state::AppState::initialize(&paths).unwrap();
        let checkout = root.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let project = state.orchestrator.add_project(checkout.to_string_lossy().into_owned(), Some("Fixture".into()), None).unwrap();
        let (gh, log) = fake_gh(&root.join("bin"));
        let gh = gh.to_string_lossy().into_owned();
        let call = |method: &'static str, params: Value| {
            let (state, gh) = (state.clone(), gh.clone());
            async move { crate::rpc::actions_call(&state, &gh, method, params).await }
        };
        let id = project.id;

        let runs: ActionsRunsResult = serde_json::from_value(
            call(ActionsRuns::NAME, json!({"project_id": id, "branch": "feat/x", "status": "failure"})).await.unwrap(),
        )
        .unwrap();
        assert_eq!((runs.runs.len(), runs.viewer.as_deref()), (1, Some("ana")));
        let detail: ActionsRunResult =
            serde_json::from_value(call(ActionsRun::NAME, json!({"project_id": id, "run_id": 5})).await.unwrap()).unwrap();
        assert_eq!(detail.jobs[0].steps[0].name, "cargo test");

        let page: ActionsLogResult =
            serde_json::from_value(call(ActionsLog::NAME, json!({"project_id": id, "job_id": 9, "offset": 1, "limit": 5})).await.unwrap())
                .unwrap();
        assert_eq!(
            (page.available, page.total_lines, page.lines.clone(), page.error_lines.clone()),
            (true, 3, vec!["##[error]boom".into(), "three".into()], vec![1])
        );
        assert!(paths.root.join("cache/actions-logs/9.log").exists(), "the log is cached on disk");
        let excerpt: ActionsLogResult =
            serde_json::from_value(call(ActionsLog::NAME, json!({"project_id": id, "job_id": 9, "excerpt": true})).await.unwrap()).unwrap();
        assert_eq!((excerpt.offset, excerpt.lines.len()), (0, 2), "ends at the error");
        let running: ActionsLogResult =
            serde_json::from_value(call(ActionsLog::NAME, json!({"project_id": id, "job_id": 10})).await.unwrap()).unwrap();
        assert!(!running.available);

        let workflows: ActionsWorkflowsResult =
            serde_json::from_value(call(ActionsWorkflows::NAME, json!({"project_id": id})).await.unwrap()).unwrap();
        assert_eq!((workflows.workflows[0].name.as_str(), workflows.default_branch.as_str()), ("CI", "main"));
        let inputs: ActionsWorkflowResult =
            serde_json::from_value(call(ActionsWorkflow::NAME, json!({"project_id": id, "workflow": "ci.yml"})).await.unwrap()).unwrap();
        assert!(inputs.dispatchable);
        assert_eq!(inputs.inputs[0].default, "all");

        for (action, job) in [("rerun", None), ("rerun_failed", None), ("rerun_job", Some(9)), ("cancel", None)] {
            call(ActionsAction::NAME, json!({"project_id": id, "action": action, "run_id": 5, "job_id": job})).await.unwrap();
        }
        call(ActionsDispatch::NAME, json!({"project_id": id, "workflow": "ci.yml", "ref": "main", "inputs": {"checks": "all"}}))
            .await
            .unwrap();
        assert!(call(ActionsDispatch::NAME, json!({"project_id": id, "workflow": "../x", "ref": "main"})).await.is_err());
        assert!(call(ActionsAction::NAME, json!({"project_id": id, "action": "rerun_job", "run_id": 5})).await.is_err());

        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("actions/runs?per_page=30&page=1&branch=feat%2Fx&status=failure"), "{calls}");
        for expected in [
            "run rerun 5\n",
            "run rerun 5 --failed\n",
            "run rerun --job 9\n",
            "run cancel 5\n",
            "workflow run ci.yml --ref main -f checks=all\n",
        ] {
            assert!(calls.contains(expected), "{expected:?} in {calls}");
        }
        assert_eq!(calls.matches("actions/jobs/9/logs").count(), 1, "the second read comes from the cache");
        let _ = std::fs::remove_dir_all(root);
    }
}
