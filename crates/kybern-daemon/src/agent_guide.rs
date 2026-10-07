//! The "Working in Kybern" guide every agent session receives.
//!
//! One renderer builds the text from the tools the session actually has, so it
//! never describes a tool the agent cannot call. The text depends on nothing
//! else (no ids, paths, dates or settings), which keeps the provider's system
//! prefix byte-identical across turns, idle releases and resumes and so keeps
//! the prompt cache warm. Changing any wording is a prompt-cache event: bump
//! [`GUIDE_VERSION`] and update the golden test.

use std::collections::BTreeSet;

/// Bumped with every wording change so a changed guide is a deliberate act.
pub(crate) const GUIDE_VERSION: u32 = 5;

/// Hard ceiling for the rendered guide (about 1.5k tokens at 4 bytes a token).
#[cfg(test)]
const MAX_GUIDE_BYTES: usize = 6000;

/// Which groups of Kybern tools a session has.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GuideTools {
    names: BTreeSet<String>,
}

impl GuideTools {
    pub(crate) fn from_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        Self { names: names.into_iter().map(str::to_owned).collect() }
    }

    fn has(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    fn any(&self, names: &[&str]) -> bool {
        names.iter().any(|name| self.has(name))
    }

    /// The listed tools the session has, in the listed order.
    fn present<'a>(&self, tools: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        tools.iter().copied().filter(|(name, _)| self.has(name)).collect()
    }
}

/// `name (what it does)` pairs joined into one readable list.
fn describe(tools: &[(&str, &str)]) -> String {
    let parts: Vec<String> = tools.iter().map(|(name, what)| format!("`{name}` ({what})")).collect();
    match parts.split_last() {
        None => String::new(),
        Some((only, [])) => only.clone(),
        Some((last, rest)) => format!("{}, and {last}", rest.join(", ")),
    }
}

const THREAD_TOOLS: [(&str, &str); 3] =
    [("kybern_threads_search", "find threads"), ("kybern_thread_read", "read a thread"), ("kybern_thread_send", "message a thread")];

const INSPECT_TOOLS: [(&str, &str); 4] = [
    ("kybern_list_terminals", "terminals the user opened"),
    ("kybern_read_terminal", "a terminal's output"),
    ("kybern_workspace_diff", "worktree changes"),
    ("kybern_runtime_tasks", "background tasks"),
];

const NOTE_TASK_TOOLS: [&str; 9] = [
    "kybern_notes_search",
    "kybern_note_read",
    "kybern_note_create",
    "kybern_note_append",
    "kybern_note_update",
    "kybern_tasks_list",
    "kybern_task_read",
    "kybern_task_create",
    "kybern_task_update",
];

/// Render the guide for a session with `tools`. Sections whose tools are absent are omitted.
pub(crate) fn render(tools: &GuideTools) -> String {
    let mut out = String::from(
        "# Working in Kybern\n\
         \n\
         You are running inside Kybern, a desktop app that hosts coding agents. Only what is specific to Kybern is covered here.\n\
         \n\
         ## Your answer\n\
         Kybern folds your tool calls and working text under a \"Worked for…\" row when a turn ends. Write the final message so it stands on its own: what you did, what you found, and what the user must decide or check.\n\
         \n\
         ## Images and files\n\
         - To show an image, embed it with Markdown, `![Caption](path/to/image.png)`. It renders only when the file (PNG, JPEG, GIF, WebP or AVIF) is inside your working folder, so copy an image from elsewhere into the folder first. Paths outside the folder, including `file://` links, do not render.\n\
         - Link files with relative paths, `[main.rs](src/main.rs)` or `[main.rs:42](src/main.rs#L42)`; Kybern shows them as clickable links that open the file.\n",
    );
    if tools.has("kybern_html_preview") && tools.has("kybern_html_publish") {
        out.push_str("\n## Visual replies\nUse interactive HTML charts, tables, diagrams, collages or mockups when asked, or when they make an explanation easier to understand. Write one self-contained document; call `kybern_html_preview` for a screenshot and console diagnostics, then `kybern_html_publish` before your final written reply. Publication stores a durable inline attachment, embeds supported absolute local image paths, and needs no browser. Preview installs Kybern’s own small headless browser on first use; retry in a minute if it is installing. Pages run scripts in an isolated sandbox and follow the reader’s light, dark and custom theme live through CSS variables (see the tool description). Keep width fluid and height content-driven; avoid an outer card or banner title. The reader sees the page: add only what it does not explain in the final reply.\n");
    }
    if tools.any(&NOTE_TASK_TOOLS) {
        out.push_str(
            "\n## Notes and tasks\n\
             To mention a note or task, paste the `markdown` link from its tool result, such as `[ADE-12 Fix login](kybern://task/<id>)`. Never write a raw `kybern://` URI or bare id; Kybern turns the link into a chip the user can click.\n",
        );
    }
    let threads = tools.present(&THREAD_TOOLS);
    let inspect = tools.present(&INSPECT_TOOLS);
    if !threads.is_empty() || !inspect.is_empty() {
        out.push_str("\n## Threads and the workspace\n");
        if !threads.is_empty() {
            out.push_str(&format!(
                "Work with the user's other Kybern threads using {}. A `@thread[<id>] Title` in the user's message refers to one.\n",
                describe(&threads)
            ));
        }
        if tools.has("kybern_thread_send") {
            out.push_str(
                "A message to another thread is queued by default, so the recipient reads it when idle; `delivery: \"steer\"` puts it into a running turn when its harness allows. A `question` gets a reply: end your turn and the reply wakes you, or set `wait_for_reply` to wait up to a minute. A message the recipient's permissions do not allow is held until the user approves it in that thread; do not resend it.\n",
            );
        }
        if !inspect.is_empty() {
            out.push_str(&format!("Inspect this thread with {}.\n", describe(&inspect)));
        }
    }
    out.push_str("\n## Native subagents\nUsers can message an active Claude native subagent in its own thread. These messages arrive at that child's next tool call as additional context; they never enter the parent's input. Pending means waiting for that callback, not delivered. File attachments arrive as readable file references, not visual multimodal input. If the child finishes first, the message stays undelivered and only the user's explicit Send to parent action queues it for the parent. Other harnesses' native child threads remain read-only.\n");
    if tools.has("kybern_agent_delegate") {
        out.push_str(
            "\n## Helpers\n\
             Hand a self-contained task to another agent with `kybern_agent_delegate`; it runs as a child thread the user can open, on any installed harness and model (`kybern_agent_capabilities` lists them). Do this when the user asks for delegation or the work clearly runs in parallel; otherwise do it yourself.\n\
             - It returns at once: delegate, then end your turn. Kybern wakes you with the results, batched when several agents finish together. Use `mode: \"wait\"` only for a short task you need before you can go on.\n\
             - The agent sees only the brief you write: the goal, the files involved, constraints, what to verify and what to report. Agents are one-shot; for another round, delegate again with a full brief and the earlier findings.\n\
             - `workspace: \"shared\"` (default) edits your checkout. The agent never commits, stashes, resets or switches branches; you integrate its edits. List `owns` globs such as `src/api/**` so Kybern warns it when it strays onto a sibling's paths. `workspace: \"worktree\"` gives it its own branch, seeded from your checkout, for parallel work on overlapping code. If your checkout is clean, merge the branch it reports; otherwise apply only its changes with `git diff <base>..<head> | git apply --3way`.\n\
             - For quick work on your own harness, prefer its built-in subagents when they support the model you want. Use `kybern_agent_delegate` for other harnesses or models, or for work Kybern should track and show the user.\n\
             - `kybern_agent_status` lists your agents; `kybern_agent_cancel` stops one.\n",
        );
    } else if tools.has("kybern_collaboration_spawn") {
        out.push_str(
            "\n## Helpers\n\
             You can hand a self-contained side task to a helper agent with `kybern_collaboration_spawn`, then follow it with `kybern_collaboration_read` or `kybern_collaboration_wait`. Do this when the user asks for delegation or parallel work; otherwise do the work yourself.\n",
        );
    }
    if tools.has("kybern_computer_act") {
        out.push_str(
            "\n## The user's Mac\n\
             Use and open apps with the `kybern_computer_*` tools (start with `kybern_computer_apps`), not shell commands. Kybern asks the user to approve each app.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_tools::native_tool_definitions;
    use crate::computer::ComputerUse;

    fn all_names() -> Vec<String> {
        let mut names: Vec<String> = native_tool_definitions().into_iter().map(|tool| tool.name).collect();
        names.extend(ComputerUse::tool_definitions().into_iter().map(|tool| tool.name));
        names
    }

    fn guide_for(names: &[&str]) -> String {
        render(&GuideTools::from_names(names.iter().copied()))
    }

    #[test]
    fn full_tool_set_matches_the_golden_text() {
        let names = all_names();
        let guide = render(&GuideTools::from_names(names.iter().map(String::as_str)));
        let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_guide_full.golden.txt");
        if std::env::var_os("KYBERN_UPDATE_GOLDEN").is_some() {
            std::fs::write(golden, &guide).unwrap();
        }
        assert_eq!(
            guide,
            include_str!("agent_guide_full.golden.txt"),
            "guide wording changed: bump GUIDE_VERSION and update the golden file (KYBERN_UPDATE_GOLDEN=1)"
        );
        assert_eq!(GUIDE_VERSION, 5);
    }

    #[test]
    fn guide_stays_within_the_token_budget() {
        let names = all_names();
        let guide = render(&GuideTools::from_names(names.iter().map(String::as_str)));
        assert!(guide.len() <= MAX_GUIDE_BYTES, "guide grew to {} bytes", guide.len());
        assert!(guide.len() >= 1500, "guide is suspiciously short: {}", guide.len());
    }

    #[test]
    fn rendering_is_byte_stable_and_order_independent() {
        let mut names = all_names();
        let first = render(&GuideTools::from_names(names.iter().map(String::as_str)));
        names.reverse();
        let second = render(&GuideTools::from_names(names.iter().map(String::as_str)));
        assert_eq!(first, second);
        assert_eq!(first.as_bytes(), render(&GuideTools::from_names(names.iter().map(String::as_str))).as_bytes());
    }

    #[test]
    fn sections_appear_only_with_their_tools() {
        let none = guide_for(&[]);
        for absent in ["## Notes and tasks", "## Threads and the workspace", "## Helpers", "## The user's Mac", "kybern_"] {
            assert!(!none.contains(absent), "{absent:?} must be omitted without tools");
        }
        assert!(none.contains("## Images and files") && none.contains("stands on its own"));

        let notes = guide_for(&["kybern_note_create"]);
        assert!(notes.contains("## Notes and tasks") && notes.contains("`markdown` link") && !notes.contains("## Helpers"));

        let threads = guide_for(&["kybern_thread_read"]);
        assert!(threads.contains("`kybern_thread_read` (read a thread)") && !threads.contains("kybern_thread_send"));

        let coordinator_like = guide_for(&["kybern_thread_read", "kybern_note_read", "kybern_collaboration_spawn"]);
        assert!(
            coordinator_like.contains("## Helpers")
                && coordinator_like.contains("`kybern_collaboration_spawn`")
                && !coordinator_like.contains("kybern_agent_delegate")
                && !coordinator_like.contains("The user's Mac")
        );

        let delegating = guide_for(&["kybern_agent_delegate", "kybern_thread_send", "kybern_collaboration_spawn"]);
        assert!(delegating.contains("## Helpers") && delegating.contains("end your turn") && delegating.contains("worktree"));
        assert!(!delegating.contains("`kybern_collaboration_spawn`"), "ordinary threads are not told about the coordinator tools");
        assert!(delegating.contains("built-in subagents") && delegating.contains("held until the user approves"));

        let computer = guide_for(&["kybern_computer_act"]);
        assert!(computer.contains("kybern_computer_apps") && !computer.contains("## Notes and tasks"));
    }

    #[test]
    fn every_tool_the_guide_names_exists() {
        let names = all_names();
        let guide = render(&GuideTools::from_names(names.iter().map(String::as_str)));
        for word in guide.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            if word.starts_with("kybern_") && !word.ends_with('_') {
                assert!(names.iter().any(|name| name == word), "guide names unknown tool {word}");
            }
        }
    }
}
