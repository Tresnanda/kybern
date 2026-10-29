//! What `machines.info` says about this machine (design §4.1): the CPU, memory and GPUs, the
//! harnesses installed here with their versions, and the identity of every project.
//!
//! The hardware does not change while the daemon runs, so it is read once, with short timeouts,
//! and kept. The harness list comes from the same provider cache `providers.list` fills, and the
//! whole answer is reused for a few minutes, so a Machines page opened on a dozen clients runs no
//! more than one probe. Every external command is `cfg`-gated, has a time limit and hides its
//! console window on Windows.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use kybern_protocol::process::NoWindow;
use kybern_protocol::{CpuInfo, HarnessSummary, MachineInfo, MemoryInfo, ProviderKind, ProviderStatus, RepoIdentity};

use crate::state::AppState;

/// How long one external command may run before its answer is given up on.
const COMMAND_BUDGET: Duration = Duration::from_secs(4);
/// How long the harness list and the project identities are reused.
const CACHE_FOR: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hardware {
    pub cpu_model: Option<String>,
    pub memory_bytes: Option<u64>,
    pub gpus: Vec<String>,
}

// ---- parsers (pure, so every OS' output format is tested everywhere) ----

/// The CPU model from `/proc/cpuinfo`: x86 says `model name`, some ARM kernels say `Model` or
/// `Hardware`.
pub fn parse_cpuinfo(text: &str) -> Option<String> {
    ["model name", "Model", "Hardware", "cpu model"].iter().find_map(|key| {
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == *key).then(|| value.trim().to_string()).filter(|value| !value.is_empty())
        })
    })
}

/// `MemTotal` of `/proc/meminfo`, in bytes.
pub fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("MemTotal:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kib.checked_mul(1024)
}

/// The display adapters in `lspci` output: `VGA compatible controller`, `3D controller` and
/// `Display controller` lines, without the bus address and the class.
pub fn parse_lspci(text: &str) -> Vec<String> {
    let mut gpus: Vec<String> = text
        .lines()
        .filter(|line| {
            let lower = line.to_lowercase();
            lower.contains("vga compatible controller") || lower.contains("3d controller") || lower.contains("display controller")
        })
        .filter_map(|line| {
            // `01:00.0 VGA compatible controller: NVIDIA Corporation GA106 [GeForce RTX 3060] (rev a1)`
            let (_, rest) = line.split_once(": ")?;
            let rest = rest.split(" (rev ").next().unwrap_or(rest).trim();
            // Prefer the marketing name between the last pair of brackets.
            let name = match (rest.rfind('['), rest.rfind(']')) {
                (Some(open), Some(close)) if close > open + 1 => {
                    let vendor = rest.split_whitespace().next().unwrap_or_default();
                    format!("{vendor} {}", &rest[open + 1..close])
                }
                _ => rest.to_string(),
            };
            Some(name.trim().to_string()).filter(|name| !name.is_empty())
        })
        .collect();
    gpus.dedup();
    gpus
}

/// The adapter names in `system_profiler SPDisplaysDataType -json`.
pub fn parse_system_profiler(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { return Vec::new() };
    value["SPDisplaysDataType"]
        .as_array()
        .map(|adapters| {
            adapters
                .iter()
                .filter_map(|adapter| adapter["sppci_model"].as_str().or_else(|| adapter["_name"].as_str()))
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// `reg query … /v ProcessorNameString`: the value is the text after `REG_SZ`.
pub fn parse_reg_query(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (_, value) = line.split_once("REG_SZ")?;
        Some(value.trim().to_string()).filter(|value| !value.is_empty())
    })
}

/// What the Windows script prints: the memory in bytes on the first line, one adapter per line after.
pub fn parse_windows_script(text: &str) -> (Option<u64>, Vec<String>) {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let memory = lines.next().and_then(|line| line.parse::<u64>().ok());
    let gpus = lines.map(str::to_string).collect();
    (memory, gpus)
}

// ---- reading the machine ----

/// Run a command and return its output when it succeeds within the budget.
async fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(program).no_window();
    command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_BUDGET, command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "macos")]
async fn read_hardware() -> Hardware {
    let (cpu, memory, gpus) = tokio::join!(
        run("sysctl", &["-n", "machdep.cpu.brand_string"]),
        run("sysctl", &["-n", "hw.memsize"]),
        run("system_profiler", &["SPDisplaysDataType", "-json"]),
    );
    Hardware {
        cpu_model: cpu.map(|text| text.trim().to_string()).filter(|text| !text.is_empty()),
        memory_bytes: memory.and_then(|text| text.trim().parse().ok()),
        gpus: gpus.map(|text| parse_system_profiler(&text)).unwrap_or_default(),
    }
}

#[cfg(target_os = "linux")]
async fn read_hardware() -> Hardware {
    let (cpuinfo, meminfo, lspci) = tokio::join!(
        tokio::fs::read_to_string("/proc/cpuinfo"),
        tokio::fs::read_to_string("/proc/meminfo"),
        // Absent in containers and on minimal installs: no adapters is the honest answer there.
        run("lspci", &[]),
    );
    Hardware {
        cpu_model: cpuinfo.ok().and_then(|text| parse_cpuinfo(&text)),
        memory_bytes: meminfo.ok().and_then(|text| parse_meminfo(&text)),
        gpus: lspci.map(|text| parse_lspci(&text)).unwrap_or_default(),
    }
}

#[cfg(windows)]
async fn read_hardware() -> Hardware {
    // `wmic` is gone from current Windows, so memory and adapters come from one PowerShell call;
    // the processor name is a registry value, which needs no process at all beyond `reg`.
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
        (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; \
        Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }";
    let reg_args = ["query", r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "/v", "ProcessorNameString"];
    let ps_args = ["-NoProfile", "-NonInteractive", "-Command", script];
    let (cpu, system) = tokio::join!(run("reg", &reg_args), run("powershell", &ps_args));
    let (memory_bytes, gpus) = system.map(|text| parse_windows_script(&text)).unwrap_or_default();
    Hardware { cpu_model: cpu.and_then(|text| parse_reg_query(&text)), memory_bytes, gpus }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn read_hardware() -> Hardware {
    Hardware::default()
}

/// This machine's hardware, read once per process.
pub async fn hardware() -> &'static Hardware {
    static HARDWARE: tokio::sync::OnceCell<Hardware> = tokio::sync::OnceCell::const_new();
    HARDWARE.get_or_init(read_hardware).await
}

// ---- harnesses ----

/// The harness list the Machines page shows, from a provider probe.
pub fn summarize(statuses: &[ProviderStatus]) -> Vec<HarnessSummary> {
    statuses
        .iter()
        .map(|status| HarnessSummary { kind: status.kind, available: status.available, signed_in: None, version: status.version.clone() })
        .collect()
}

/// The status of every harness on this machine, from the cache `providers.list` shares. With a
/// `project_id` and `cwd`, a project's own settings apply.
pub async fn provider_statuses(
    state: &AppState,
    project_id: Option<kybern_protocol::ProjectId>,
    cwd: Option<std::path::PathBuf>,
    force_refresh: bool,
) -> Vec<ProviderStatus> {
    let settings = state.settings.get();
    let Ok(cache_key) = serde_json::to_string(&(project_id, cwd.as_ref(), &settings.providers)) else { return Vec::new() };
    state
        .provider_catalogs
        .get_or_refresh(cache_key, force_refresh, || async move {
            let probes = ProviderKind::ALL.into_iter().map(|kind| {
                let driver = state.drivers.get(kind);
                let provider_settings = crate::settings::provider_settings(&settings, kind, cwd.as_deref().and_then(|p| p.to_str()));
                let context = kybern_drivers::ProbeContext {
                    binary: provider_settings.binary.map(std::path::PathBuf::from),
                    cwd: cwd.clone(),
                    env: provider_settings.env,
                };
                async move {
                    match driver {
                        Some(driver) => {
                            let mut status = driver.probe_with_context(&context).await;
                            status.instances =
                                std::iter::once("default".to_string()).chain(provider_settings.accounts.keys().cloned()).collect();
                            status
                        }
                        None => ProviderStatus {
                            kind,
                            display_name: kind.display_name().to_string(),
                            available: false,
                            binary_path: None,
                            version: None,
                            unavailable_reason: Some("driver not implemented yet".into()),
                            supported_permission_modes: vec![],
                            supports_fork: false,
                            supports_model_switch: false,
                            supports_effort_switch: false,
                            supported_efforts: vec![],
                            models: vec![],
                            instances: vec![],
                        },
                    }
                }
            });
            futures::future::join_all(probes).await
        })
        .await
}

// ---- the answer ----

/// Every project's identity on this machine, each repository once.
pub fn project_identities(state: &AppState) -> Vec<RepoIdentity> {
    let mut identities: Vec<RepoIdentity> = state
        .store
        .projects_list()
        .map(|projects| projects.into_iter().flat_map(|project| project.repo.into_iter().chain(project.repos)).collect())
        .unwrap_or_default();
    identities.retain(|identity| !identity.is_empty());
    identities.sort();
    identities.dedup();
    identities
}

fn cpu_of(hardware: &Hardware) -> CpuInfo {
    let logical_cores = std::thread::available_parallelism().map(|cores| cores.get() as u32).unwrap_or(1);
    CpuInfo { model: hardware.cpu_model.clone().unwrap_or_else(|| std::env::consts::ARCH.to_string()), logical_cores }
}

struct Cached {
    at: Instant,
    harnesses: Vec<HarnessSummary>,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The harness summary, reused for [`CACHE_FOR`].
async fn harnesses(state: &AppState) -> Vec<HarnessSummary> {
    if let Some(cached) =
        cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().filter(|cached| cached.at.elapsed() < CACHE_FOR)
    {
        return cached.harnesses.clone();
    }
    let harnesses = summarize(&provider_statuses(state, None, None, false).await);
    *cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Cached { at: Instant::now(), harnesses: harnesses.clone() });
    harnesses
}

/// `machines.info`.
pub async fn info(state: &AppState) -> MachineInfo {
    let hardware = hardware().await;
    MachineInfo {
        cpu: Some(cpu_of(hardware)),
        gpu: hardware.gpus.clone(),
        mem: hardware.memory_bytes.map(|total_bytes| MemoryInfo { total_bytes }),
        harnesses: harnesses(state).await,
        projects: project_identities(state),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpuinfo_names_the_model_on_x86_and_arm() {
        let x86 = "processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\ncpu MHz\t: 3800.0\n";
        assert_eq!(parse_cpuinfo(x86).as_deref(), Some("AMD Ryzen 7 5800X 8-Core Processor"));
        let arm = "processor\t: 0\nBogoMIPS\t: 108.00\nHardware\t: BCM2835\nModel\t\t: Raspberry Pi 4 Model B Rev 1.4\n";
        assert_eq!(parse_cpuinfo(arm).as_deref(), Some("Raspberry Pi 4 Model B Rev 1.4"));
        assert_eq!(parse_cpuinfo("processor\t: 0\n"), None);
        assert_eq!(parse_cpuinfo("model name\t:   \n"), None);
    }

    #[test]
    fn meminfo_reads_total_memory_in_bytes() {
        assert_eq!(parse_meminfo("MemTotal:       16384000 kB\nMemFree:  100 kB\n"), Some(16_384_000 * 1024));
        assert_eq!(parse_meminfo("MemFree: 100 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: lots kB\n"), None);
    }

    #[test]
    fn lspci_lists_display_adapters_by_their_marketing_name() {
        let text = "00:00.0 Host bridge: Intel Corporation Device 1234\n\
            00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)\n\
            01:00.0 VGA compatible controller: NVIDIA Corporation GA106 [GeForce RTX 3060] (rev a1)\n\
            02:00.0 3D controller: NVIDIA Corporation GA100 [A100 PCIe] (rev a1)\n\
            03:00.0 Ethernet controller: Realtek RTL8111\n";
        assert_eq!(parse_lspci(text), ["Intel Corporation UHD Graphics 630", "NVIDIA GeForce RTX 3060", "NVIDIA A100 PCIe"]);
        assert!(parse_lspci("").is_empty());
    }

    #[test]
    fn system_profiler_lists_the_adapters() {
        let text = r#"{"SPDisplaysDataType":[{"_name":"Apple M3 Pro","sppci_model":"Apple M3 Pro","spdisplays_cores":"18"},{"_name":"Radeon Pro 560X"}]}"#;
        assert_eq!(parse_system_profiler(text), ["Apple M3 Pro", "Radeon Pro 560X"]);
        assert!(parse_system_profiler("not json").is_empty());
        assert!(parse_system_profiler("{}").is_empty());
    }

    #[test]
    fn windows_output_gives_the_processor_memory_and_adapters() {
        let reg = "\r\nHKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0\r\n    ProcessorNameString    REG_SZ    AMD Ryzen 5 5600X 6-Core Processor\r\n";
        assert_eq!(parse_reg_query(reg).as_deref(), Some("AMD Ryzen 5 5600X 6-Core Processor"));
        assert_eq!(parse_reg_query("ERROR: The system was unable to find the specified registry key or value."), None);
        let script = "34255613952\r\nNVIDIA GeForce RTX 3060\r\nAMD Radeon(TM) Graphics\r\n";
        assert_eq!(
            parse_windows_script(script),
            (Some(34_255_613_952), vec!["NVIDIA GeForce RTX 3060".to_string(), "AMD Radeon(TM) Graphics".to_string()])
        );
        assert_eq!(parse_windows_script(""), (None, Vec::new()));
    }

    #[test]
    fn a_summary_keeps_the_version_and_availability() {
        let status = |kind, available, version: Option<&str>| ProviderStatus {
            kind,
            display_name: String::new(),
            available,
            binary_path: None,
            version: version.map(str::to_string),
            unavailable_reason: None,
            supported_permission_modes: vec![],
            supports_fork: false,
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec![],
        };
        let summary = summarize(&[status(ProviderKind::ClaudeCode, true, Some("2.1.0")), status(ProviderKind::Codex, false, None)]);
        assert_eq!(summary.len(), 2);
        assert!(summary[0].available && summary[0].version.as_deref() == Some("2.1.0"));
        assert!(!summary[1].available && summary[1].version.is_none());
    }

    /// Whatever this machine is, reading it must finish and give a CPU model on the three OSes
    /// the daemon ships for.
    #[tokio::test]
    async fn this_machine_reports_a_cpu_and_its_memory() {
        let hardware = hardware().await;
        // Some ARM kernels print no model in /proc/cpuinfo, and the answer falls back to the architecture.
        if cfg!(any(target_os = "macos", windows, all(target_os = "linux", target_arch = "x86_64"))) {
            assert!(hardware.cpu_model.as_deref().is_some_and(|model| !model.is_empty()), "no CPU model: {hardware:?}");
        }
        if cfg!(any(target_os = "macos", target_os = "linux", windows)) {
            assert!(hardware.memory_bytes.is_some_and(|bytes| bytes > 64 * 1024 * 1024), "no memory size: {hardware:?}");
        }
        let cpu = cpu_of(hardware);
        assert!(cpu.logical_cores >= 1 && !cpu.model.is_empty());
    }
}
