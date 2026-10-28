//! What a forwarded agent tool may do on another machine (ADE-86 M2 / R2, design §6.3).
//!
//! Pure rules, no I/O: which tools take a `machine`, which scopes the target needs for each class of
//! tool, the narrowing table (the caller's permission mode only ever narrows what runs on the target),
//! and the fence. `orchestrator/inbound.rs` applies them: the calling side builds `peer.tool.call`, the
//! serving side checks it against these rules and runs the tool as an inbound thread.
//!
//! **Narrowing.** The caller's permission mode travels with the call. On the target it maps per class:
//!
//! | mode | read | operate (send, interrupt, preview) | note and task writes | terminal commands | computer use |
//! | --- | --- | --- | --- | --- | --- |
//! | supervised | run | ask | ask | ask | ask per app |
//! | accept-edits | run | ask | ask | ask | ask per app |
//! | auto | run | run | run | ask | ask per app |
//! | full-access | run | run | run | run | ask per app |
//!
//! The design says accept-edits "runs file and note writes". No forwarded tool writes files, and the
//! existing rule that notes and tasks ask for consent outside Full access/Auto applies on the target in
//! every mode, so accept-edits behaves like supervised here.
//!
//! **The fence.** Below Full access an inbound call may change only threads whose origin is the calling
//! machine, and it can never change projects, settings, the network, a broker or secrets: the tool table
//! below is an allow-list, and a tool that is not on it (a Coordinator's git tool, a secret or login
//! request, delegation) is refused at every mode. Nothing is forwarded onward: `hops == [caller]`.

use std::collections::BTreeMap;

use kybern_drivers::NativeToolDefinition;
use kybern_protocol::{PermissionMode, Scope, ThreadId};
use serde_json::{Value, json};

/// The tool that lists the members of the network.
pub const MACHINES_TOOL: &str = "kybern_machines";

/// The argument that names the machine to run a tool on.
pub const MACHINE_ARG: &str = "machine";
/// The argument that names one of that machine's projects.
pub const PROJECT_ARG: &str = "project";

/// What kind of tool a call is, for scopes, narrowing and the fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolClass {
    /// Reads Kybern's own state: threads, notes, tasks, project map, diffs.
    Read,
    /// Reads files: also needs `machine:files` on the target.
    FileRead,
    /// Lists and reads terminals: also needs `machine:terminals`.
    TerminalRead,
    /// Runs a command: also needs `machine:terminals`.
    TerminalRun,
    /// Creates or changes a note or task.
    NoteWrite,
    /// Messages or interrupts a thread, opens a preview.
    Operate,
    /// `kybern_computer_*`. Per-app consent is always asked on the target.
    Computer,
    /// `kybern_machines`.
    Machines,
    /// `kybern_agent_*`: forwarded by remote delegation (`machine:delegate`), not by `peer.tool.call`.
    Delegation,
    /// Everything else: never runs for another machine.
    NotForwarded,
}

impl ToolClass {
    /// The classes `peer.tool.call` serves.
    pub fn is_forwardable(self) -> bool {
        !matches!(self, ToolClass::Delegation | ToolClass::NotForwarded)
    }

    /// The scopes the target must grant the calling machine, `machine:tools` first.
    pub fn scopes(self) -> &'static [Scope] {
        match self {
            ToolClass::FileRead => &[Scope::MachineTools, Scope::MachineFiles],
            ToolClass::TerminalRead | ToolClass::TerminalRun => &[Scope::MachineTools, Scope::MachineTerminals],
            ToolClass::Delegation => &[Scope::MachineDelegate],
            _ => &[Scope::MachineTools],
        }
    }
}

/// The class of one Kybern agent tool.
pub fn classify(tool: &str) -> ToolClass {
    match tool {
        "kybern_threads_search"
        | "kybern_thread_read"
        | "kybern_thread_context"
        | "kybern_project_map"
        | "kybern_workspace_diff"
        | "kybern_notes_search"
        | "kybern_note_read"
        | "kybern_tasks_list"
        | "kybern_task_read" => ToolClass::Read,
        "kybern_list_files" | "kybern_read_file" => ToolClass::FileRead,
        "kybern_list_terminals" | "kybern_read_terminal" => ToolClass::TerminalRead,
        "kybern_run_in_terminal" => ToolClass::TerminalRun,
        "kybern_note_create" | "kybern_note_append" | "kybern_note_update" | "kybern_task_create" | "kybern_task_update" => {
            ToolClass::NoteWrite
        }
        "kybern_thread_send" | "kybern_thread_interrupt" | "kybern_preview_open" => ToolClass::Operate,
        MACHINES_TOOL => ToolClass::Machines,
        "kybern_agent_delegate" | "kybern_agent_status" | "kybern_agent_cancel" | "kybern_agent_wait" => ToolClass::Delegation,
        name if name.starts_with("kybern_computer_") => ToolClass::Computer,
        _ => ToolClass::NotForwarded,
    }
}

/// Whether a tool is about a checkout (files, terminals, diffs, the map), so the target must find the
/// calling thread's repository or be told the project.
pub fn project_bound(tool: &str) -> bool {
    matches!(
        tool,
        "kybern_list_files"
            | "kybern_read_file"
            | "kybern_list_terminals"
            | "kybern_read_terminal"
            | "kybern_run_in_terminal"
            | "kybern_workspace_diff"
            | "kybern_project_map"
    )
}

/// What the narrowing table says for one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The tool runs.
    Run,
    /// The user on the target is asked first.
    Ask,
}

/// The narrowing table (see the module docs): what happens on the target to a call of `class` whose
/// caller holds `cap`.
pub fn decide(cap: PermissionMode, class: ToolClass) -> Decision {
    use PermissionMode::*;
    match class {
        ToolClass::Read | ToolClass::FileRead | ToolClass::TerminalRead | ToolClass::Machines => Decision::Run,
        ToolClass::Operate | ToolClass::NoteWrite => match cap {
            Auto | FullAccess => Decision::Run,
            Supervised | AcceptEdits => Decision::Ask,
        },
        ToolClass::TerminalRun => match cap {
            FullAccess => Decision::Run,
            _ => Decision::Ask,
        },
        // Per-app consent is asked on the target in every mode.
        ToolClass::Computer => Decision::Ask,
        ToolClass::Delegation | ToolClass::NotForwarded => Decision::Ask,
    }
}

/// The mode the target's own tool code sees for a call. A computer-use call is held to `Supervised`,
/// whose rule asks per app (and for the real cursor) whatever the caller holds; every other class keeps
/// the caller's mode, which is what the notes-and-tasks and terminal rules already read.
pub fn effective_mode(cap: PermissionMode, class: ToolClass) -> PermissionMode {
    if class == ToolClass::Computer { PermissionMode::Supervised } else { cap }
}

/// Whether the calling mode is below Full access, where the fence applies in full.
pub fn fenced(cap: PermissionMode) -> bool {
    cap != PermissionMode::FullAccess
}

/// The thread a tool changes, for the rule that inbound work may change only the threads another
/// machine's work created.
pub fn changes_thread(tool: &str, args: &Value) -> Option<ThreadId> {
    match tool {
        "kybern_thread_send" | "kybern_thread_interrupt" => args.get("thread_id")?.as_str()?.parse().ok(),
        _ => None,
    }
}

/// What each capability scope of a target is for the calling machine, from its `allow.*` registers and
/// the defaults (`Scope::MACHINE_DEFAULT`).
pub fn capability_view(allowed: &BTreeMap<String, bool>) -> BTreeMap<String, bool> {
    Scope::MACHINE
        .into_iter()
        .filter_map(|scope| {
            let capability = scope.capability()?;
            Some((capability.to_string(), allowed.get(capability).copied().unwrap_or_else(|| Scope::MACHINE_DEFAULT.contains(&scope))))
        })
        .collect()
}

// ---- tool definitions ----

const MACHINE_ARG_HELP: &str = "Run this tool on another machine of your network (name or id from kybern_machines). Omit to run it here. Fails at once when that machine is offline.";
const PROJECT_ARG_HELP: &str =
    "With machine: that machine's project (name, id or path from kybern_machines). Defaults to its checkout of this thread's repository.";

/// Add the `machine` argument (and `project` for tools about a checkout) to the tools a forwarded call
/// can reach. Without it they behave exactly as before.
pub fn offer_machine_args(tools: &mut [NativeToolDefinition]) {
    for tool in tools {
        if !classify(&tool.name).is_forwardable() || classify(&tool.name) == ToolClass::Machines {
            continue;
        }
        let Some(properties) = tool.input_schema.get_mut("properties").and_then(Value::as_object_mut) else { continue };
        properties.entry(MACHINE_ARG).or_insert_with(|| json!({"type": ["string", "null"], "description": MACHINE_ARG_HELP}));
        if project_bound(&tool.name) {
            properties.entry(PROJECT_ARG).or_insert_with(|| json!({"type": ["string", "null"], "description": PROJECT_ARG_HELP}));
        }
    }
}

/// `kybern_machines`.
pub fn machines_tool_definition() -> NativeToolDefinition {
    NativeToolDefinition {
        name: MACHINES_TOOL.into(),
        description: "List the machines of your network: name, id, OS, whether each is online, harnesses, projects with their repository identity, what each allows (tools, files, terminals, delegation…) and features. Read-only. It never shows addresses or keys. Use it before naming a machine in `machine`.".into(),
        input_schema: json!({"type": "object", "additionalProperties": false, "properties": {}, "required": []}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionMode::*;

    const MODES: [PermissionMode; 4] = [Supervised, AcceptEdits, Auto, FullAccess];

    #[test]
    fn the_narrowing_table_gives_run_or_ask_for_every_mode_and_class() {
        use Decision::*;
        use ToolClass::*;
        // (class, [supervised, accept-edits, auto, full-access])
        let table: [(ToolClass, [Decision; 4]); 7] = [
            (Read, [Run, Run, Run, Run]),
            (FileRead, [Run, Run, Run, Run]),
            (TerminalRead, [Run, Run, Run, Run]),
            (Operate, [Ask, Ask, Run, Run]),
            (NoteWrite, [Ask, Ask, Run, Run]),
            (TerminalRun, [Ask, Ask, Ask, Run]),
            (Computer, [Ask, Ask, Ask, Ask]),
        ];
        for (class, expected) in table {
            for (mode, expected) in MODES.into_iter().zip(expected) {
                assert_eq!(decide(mode, class), expected, "{class:?} at {mode:?}");
            }
        }
    }

    #[test]
    fn a_stricter_mode_never_runs_what_a_looser_one_asks_about() {
        let rank = |mode: PermissionMode| MODES.iter().position(|candidate| *candidate == mode).unwrap();
        for class in [ToolClass::Read, ToolClass::Operate, ToolClass::NoteWrite, ToolClass::TerminalRun, ToolClass::Computer] {
            for a in MODES {
                for b in MODES {
                    if rank(a) <= rank(b) && decide(a, class) == Decision::Run {
                        assert_eq!(decide(b, class), Decision::Run, "{class:?}: {a:?} runs, so {b:?} must");
                    }
                }
            }
        }
    }

    #[test]
    fn computer_use_is_held_to_the_per_app_rule_whatever_the_caller_holds() {
        for mode in MODES {
            assert_eq!(effective_mode(mode, ToolClass::Computer), Supervised);
            assert_eq!(effective_mode(mode, ToolClass::Read), mode);
            assert_eq!(effective_mode(mode, ToolClass::TerminalRun), mode);
        }
    }

    #[test]
    fn scopes_follow_the_class() {
        assert_eq!(ToolClass::Read.scopes(), &[Scope::MachineTools]);
        assert_eq!(ToolClass::FileRead.scopes(), &[Scope::MachineTools, Scope::MachineFiles]);
        assert_eq!(ToolClass::TerminalRead.scopes(), &[Scope::MachineTools, Scope::MachineTerminals]);
        assert_eq!(ToolClass::TerminalRun.scopes(), &[Scope::MachineTools, Scope::MachineTerminals]);
        assert_eq!(classify("kybern_read_file"), ToolClass::FileRead);
        assert_eq!(classify("kybern_run_in_terminal"), ToolClass::TerminalRun);
        assert_eq!(classify("kybern_computer_act"), ToolClass::Computer);
    }

    #[test]
    fn what_changes_projects_settings_or_the_network_is_never_forwarded() {
        for tool in [
            "kybern_git",
            "kybern_coordinator_propose_brief",
            "kybern_request_secret",
            "kybern_request_login",
            "kybern_request_permission",
            "kybern_request_pick",
            "kybern_ask_user",
            "kybern_html_publish",
            "kybern_html_preview",
            "kybern_task_claim",
            "kybern_runtime_tasks",
            "kybern_pending_questions",
            "kybern_answer_question",
            "kybern_agent_capabilities",
            "projects.add",
            "settings.update",
            "network.remove",
        ] {
            assert_eq!(classify(tool), ToolClass::NotForwarded, "{tool}");
            assert!(!classify(tool).is_forwardable());
        }
        // Delegation travels by `peer.delegate`, never by a tool call.
        for tool in ["kybern_agent_delegate", "kybern_agent_status", "kybern_agent_cancel", "kybern_agent_wait"] {
            assert_eq!(classify(tool), ToolClass::Delegation);
            assert!(!classify(tool).is_forwardable());
        }
    }

    #[test]
    fn only_the_threads_a_send_or_interrupt_names_are_checked_by_the_fence() {
        let id = uuid::Uuid::now_v7();
        assert_eq!(changes_thread("kybern_thread_send", &json!({"thread_id": id.to_string(), "body": "x"})), Some(id));
        assert_eq!(changes_thread("kybern_thread_interrupt", &json!({"thread_id": id.to_string()})), Some(id));
        assert_eq!(changes_thread("kybern_thread_send", &json!({"thread_id": "not a uuid"})), None);
        assert_eq!(changes_thread("kybern_thread_read", &json!({"thread_id": id.to_string()})), None);
        assert!(fenced(Supervised) && fenced(AcceptEdits) && fenced(Auto) && !fenced(FullAccess));
    }

    #[test]
    fn capabilities_default_on_except_the_universal_clipboard() {
        let view = capability_view(&BTreeMap::new());
        assert_eq!(view.get("tools"), Some(&true));
        assert_eq!(view.get("files"), Some(&true));
        assert_eq!(view.get("clipboard_auto"), Some(&false));
        let view = capability_view(&BTreeMap::from([("files".to_string(), false)]));
        assert_eq!(view.get("files"), Some(&false));
        assert_eq!(view.get("tools"), Some(&true));
    }

    #[test]
    fn the_machine_argument_is_offered_only_to_tools_a_call_can_reach() {
        let schema =
            || json!({"type": "object", "additionalProperties": false, "properties": {"path": {"type": "string"}}, "required": []});
        let mut tools: Vec<NativeToolDefinition> =
            ["kybern_read_file", "kybern_threads_search", "kybern_html_publish", "kybern_agent_delegate", MACHINES_TOOL]
                .into_iter()
                .map(|name| NativeToolDefinition { name: name.into(), description: String::new(), input_schema: schema() })
                .collect();
        offer_machine_args(&mut tools);
        let has = |tool: &NativeToolDefinition, arg: &str| tool.input_schema["properties"].get(arg).is_some();
        assert!(has(&tools[0], MACHINE_ARG) && has(&tools[0], PROJECT_ARG), "files are about a checkout");
        assert!(has(&tools[1], MACHINE_ARG) && !has(&tools[1], PROJECT_ARG));
        assert!(!has(&tools[2], MACHINE_ARG), "visuals are not forwarded");
        assert!(!has(&tools[3], MACHINE_ARG), "delegation has its own machine argument");
        assert!(!has(&tools[4], MACHINE_ARG), "listing machines is not about a machine");
    }
}
