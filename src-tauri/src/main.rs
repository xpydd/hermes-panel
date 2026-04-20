#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Local;
use dirs::home_dir;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod panel_v1;

const OFFICIAL_INSTALL_UNIX: &str =
    "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash";
const DASHBOARD_CACHE_TTL_MS: u64 = 1_500;
const HERMES_PROBE_TIMEOUT_MS: u64 = 1_800;
const QUICK_VERSION_TIMEOUT_MS: u64 = 550;
const QUICK_GATEWAY_TIMEOUT_MS: u64 = 700;
const PROFILE_PROBE_TIMEOUT_MS: u64 = 850;
const SESSION_CACHE_TTL_MS: u64 = 5_000;
const SQLITE_QUERY_TIMEOUT_MS: u64 = 1_500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
    generated_at: String,
    platform: String,
    arch: String,
    hermes: HermesStatus,
    files: HermesFiles,
    paths: AppPaths,
    profiles: Vec<ProfileSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesStatus {
    installed: bool,
    version: String,
    path: String,
    status_summary: String,
    gateway_summary: String,
    profile_summary: String,
    last_checked: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesFiles {
    config_path: String,
    env_path: String,
    config_text: String,
    env_text: String,
    basic: HermesBasicSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    hermes_home: String,
    profiles_dir: String,
    backups_dir: String,
    history_file: String,
    sessions_dir: String,
    logs_dir: String,
    state_db: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesBasicSettings {
    model: String,
    terminal_backend: String,
    terminal_cwd: String,
    worktree: bool,
    memory_enabled: bool,
    user_profile_enabled: bool,
    openrouter_api_key: String,
    openai_api_key: String,
    openai_base_url: String,
    messaging_cwd: String,
    messaging_group_sessions_per_user: bool,
    discord_require_mention: bool,
    discord_auto_thread: bool,
    discord_free_response_channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummary {
    name: String,
    current: bool,
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandHistoryEntry {
    id: String,
    title: String,
    command: String,
    status: String,
    code: i32,
    combined: String,
    started_at: String,
    finished_at: String,
    duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    source: String,
    title: String,
    model: String,
    preview: String,
    started_at: String,
    ended_at: String,
    last_active: String,
    message_count: usize,
    active: bool,
    parent_session_id: String,
    storage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMessage {
    id: String,
    role: String,
    content: String,
    tool_name: String,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    title: String,
    command: String,
    status: String,
    code: i32,
    stdout: String,
    stderr: String,
    combined: String,
    started_at: String,
    finished_at: String,
    duration_ms: u64,
    refresh_snapshot: bool,
}

#[derive(Debug)]
struct CommandCapture {
    command: String,
    code: i32,
    stdout: String,
    stderr: String,
    combined: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArchiveFile {
    session_id: String,
    model: Option<String>,
    platform: Option<String>,
    session_start: Option<String>,
    last_updated: Option<String>,
    message_count: Option<usize>,
    messages: Option<Vec<SessionArchiveMessage>>,
}

#[derive(Debug, Deserialize)]
struct SessionArchiveMessage {
    role: String,
    content: Option<String>,
}

#[derive(Debug)]
struct DashboardCacheEntry {
    cached_at: Instant,
    snapshot: DashboardSnapshot,
}

#[derive(Debug)]
struct SessionSummaryCacheEntry {
    cached_at: Instant,
    summaries: Vec<SessionSummary>,
}

static DASHBOARD_CACHE: LazyLock<Mutex<Option<DashboardCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));
static DASHBOARD_BUILD_GATE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static SESSION_SUMMARY_CACHE: LazyLock<Mutex<Option<SessionSummaryCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));

#[tauri::command]
async fn load_session_messages(session_id: String) -> Result<Vec<SessionMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || load_session_messages_for_id(&session_id))
        .await
        .map_err(|error| error.to_string())
}

fn build_dashboard() -> Result<DashboardSnapshot, String> {
    if let Ok(cache) = DASHBOARD_CACHE.lock() {
        if let Some(entry) = cache.as_ref() {
            if entry.cached_at.elapsed() < Duration::from_millis(DASHBOARD_CACHE_TTL_MS) {
                return Ok(entry.snapshot.clone());
            }
        }
    }

    let _guard = DASHBOARD_BUILD_GATE
        .lock()
        .map_err(|_| "状态同步锁异常。".to_string())?;

    if let Ok(cache) = DASHBOARD_CACHE.lock() {
        if let Some(entry) = cache.as_ref() {
            if entry.cached_at.elapsed() < Duration::from_millis(DASHBOARD_CACHE_TTL_MS) {
                return Ok(entry.snapshot.clone());
            }
        }
    }

    let snapshot = build_dashboard_fresh()?;
    if let Ok(mut cache) = DASHBOARD_CACHE.lock() {
        *cache = Some(DashboardCacheEntry {
            cached_at: Instant::now(),
            snapshot: snapshot.clone(),
        });
    }
    Ok(snapshot)
}

pub(crate) fn build_dashboard_light() -> Result<DashboardSnapshot, String> {
    let generated_at = now_string();
    let config_path = hermes_home().join("config.yaml");
    let env_path = hermes_home().join(".env");
    let config_text =
        fs::read_to_string(&config_path).unwrap_or_else(|_| default_config_template());
    let env_text = fs::read_to_string(&env_path).unwrap_or_else(|_| default_env_template());
    let basic = extract_basic_settings(&config_text, &env_text)?;
    let executable = locate_command("hermes");
    let mut profiles = fallback_profiles_from_filesystem();
    profiles.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.name.cmp(&right.name))
    });

    let installed = executable.is_some();
    let hermes = HermesStatus {
        installed,
        version: if installed {
            "已检测到 Hermes".to_string()
        } else {
            "未安装".to_string()
        },
        path: executable
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        status_summary: if installed {
            "已检测到 Hermes，可稍候自动同步详细状态。".to_string()
        } else {
            "未检测到 `hermes` 可执行文件".to_string()
        },
        gateway_summary: if installed {
            "状态同步中，请稍候。".to_string()
        } else {
            "Gateway 尚未可用".to_string()
        },
        profile_summary: if profiles.is_empty() {
            "正在识别本地身份。".to_string()
        } else {
            format!("已识别 {} 个本地身份。", profiles.len())
        },
        last_checked: now_string(),
    };

    Ok(DashboardSnapshot {
        generated_at,
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hermes,
        files: HermesFiles {
            config_path: config_path.to_string_lossy().to_string(),
            env_path: env_path.to_string_lossy().to_string(),
            config_text,
            env_text,
            basic,
        },
        paths: build_paths(),
        profiles,
    })
}

pub(crate) fn build_dashboard_profile_aware() -> Result<DashboardSnapshot, String> {
    let generated_at = now_string();
    let config_path = hermes_home().join("config.yaml");
    let env_path = hermes_home().join(".env");
    let config_text =
        fs::read_to_string(&config_path).unwrap_or_else(|_| default_config_template());
    let env_text = fs::read_to_string(&env_path).unwrap_or_else(|_| default_env_template());
    let basic = extract_basic_settings(&config_text, &env_text)?;
    let executable = locate_command("hermes");
    let mut profiles = load_profiles_quick();
    profiles.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.name.cmp(&right.name))
    });

    let installed = executable.is_some();
    let hermes = HermesStatus {
        installed,
        version: if installed {
            "已检测到 Hermes".to_string()
        } else {
            "未安装".to_string()
        },
        path: executable
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        status_summary: if installed {
            "已检测到 Hermes，可稍候自动同步详细状态。".to_string()
        } else {
            "未检测到 `hermes` 可执行文件".to_string()
        },
        gateway_summary: if installed {
            "状态同步中，请稍候。".to_string()
        } else {
            "Gateway 尚未可用".to_string()
        },
        profile_summary: if profiles.is_empty() {
            "正在识别本地身份。".to_string()
        } else {
            format!("已识别 {} 个本地身份。", profiles.len())
        },
        last_checked: now_string(),
    };

    Ok(DashboardSnapshot {
        generated_at,
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hermes,
        files: HermesFiles {
            config_path: config_path.to_string_lossy().to_string(),
            env_path: env_path.to_string_lossy().to_string(),
            config_text,
            env_text,
            basic,
        },
        paths: build_paths(),
        profiles,
    })
}

pub(crate) fn build_dashboard_quick() -> Result<DashboardSnapshot, String> {
    let generated_at = now_string();
    let config_path = hermes_home().join("config.yaml");
    let env_path = hermes_home().join(".env");
    let config_text =
        fs::read_to_string(&config_path).unwrap_or_else(|_| default_config_template());
    let env_text = fs::read_to_string(&env_path).unwrap_or_else(|_| default_env_template());
    let basic = extract_basic_settings(&config_text, &env_text)?;
    let (hermes, profiles) = inspect_hermes_quick();

    Ok(DashboardSnapshot {
        generated_at,
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hermes,
        files: HermesFiles {
            config_path: config_path.to_string_lossy().to_string(),
            env_path: env_path.to_string_lossy().to_string(),
            config_text,
            env_text,
            basic,
        },
        paths: build_paths(),
        profiles,
    })
}

fn build_dashboard_fresh() -> Result<DashboardSnapshot, String> {
    let generated_at = now_string();
    let config_path = hermes_home().join("config.yaml");
    let env_path = hermes_home().join(".env");
    let config_text =
        fs::read_to_string(&config_path).unwrap_or_else(|_| default_config_template());
    let env_text = fs::read_to_string(&env_path).unwrap_or_else(|_| default_env_template());
    let basic = extract_basic_settings(&config_text, &env_text)?;
    let (hermes, profiles) = inspect_hermes();
    Ok(DashboardSnapshot {
        generated_at,
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hermes,
        files: HermesFiles {
            config_path: config_path.to_string_lossy().to_string(),
            env_path: env_path.to_string_lossy().to_string(),
            config_text,
            env_text,
            basic,
        },
        paths: build_paths(),
        profiles,
    })
}

pub(crate) fn invalidate_dashboard_cache() {
    if let Ok(mut cache) = DASHBOARD_CACHE.lock() {
        *cache = None;
    }
}

fn inspect_hermes() -> (HermesStatus, Vec<ProfileSummary>) {
    let executable = locate_command("hermes");
    let last_checked = now_string();

    if let Some(path) = executable {
        let probe_timeout = Duration::from_millis(HERMES_PROBE_TIMEOUT_MS);
        let version_path = path.clone();
        let version_handle = thread::spawn(move || {
            run_direct_with_timeout(&version_path, &owned_args(&["version"]), probe_timeout)
                .or_else(|_| {
                    run_direct_with_timeout(
                        &version_path,
                        &owned_args(&["--version"]),
                        probe_timeout,
                    )
                })
        });
        let gateway_path = path.clone();
        let gateway_handle = thread::spawn(move || {
            run_direct_with_timeout(
                &gateway_path,
                &owned_args(&["gateway", "status"]),
                probe_timeout,
            )
        });
        let profile_path = path.clone();
        let profile_handle = thread::spawn(move || {
            run_direct_with_timeout(
                &profile_path,
                &owned_args(&["profile", "list"]),
                probe_timeout,
            )
        });

        let version = version_handle
            .join()
            .unwrap_or_else(|_| Err("版本检测任务中断。".to_string()))
            .map(|capture| first_nonempty_line(&capture.combined))
            .unwrap_or_else(|error| {
                if is_timeout_error(&error) {
                    "已安装，但版本检测超时".to_string()
                } else {
                    "已安装，但未读取到版本".to_string()
                }
            });

        let status_summary = "已检测到 Hermes，可通过体检进一步确认。".to_string();

        let gateway_summary = gateway_handle
            .join()
            .unwrap_or_else(|_| Err("Gateway 检测任务中断。".to_string()))
            .map(|capture| summarize_output(&capture.combined))
            .unwrap_or_else(|error| probe_failure_message("hermes gateway status", &error));

        let profile_capture = profile_handle
            .join()
            .unwrap_or_else(|_| Err("身份列表检测任务中断。".to_string()));
        let profile_summary = profile_capture
            .as_ref()
            .map(|capture| summarize_output(&capture.combined))
            .unwrap_or_else(|error| probe_failure_message("hermes profile list", error));
        let mut profiles = profile_capture
            .as_ref()
            .map(|capture| parse_profile_output(&capture.combined))
            .unwrap_or_default();

        if profiles.is_empty() {
            profiles = fallback_profiles_from_filesystem();
        }

        profiles.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then(left.name.cmp(&right.name))
        });

        (
            HermesStatus {
                installed: true,
                version,
                path: path.to_string_lossy().to_string(),
                status_summary,
                gateway_summary,
                profile_summary,
                last_checked,
            },
            profiles,
        )
    } else {
        (
            HermesStatus {
                installed: false,
                version: "未安装".to_string(),
                path: String::new(),
                status_summary: "未检测到 `hermes` 可执行文件".to_string(),
                gateway_summary: "Gateway 尚未可用".to_string(),
                profile_summary: "安装 Hermes 后可列出 profile".to_string(),
                last_checked,
            },
            fallback_profiles_from_filesystem(),
        )
    }
}

fn inspect_hermes_quick() -> (HermesStatus, Vec<ProfileSummary>) {
    let executable = locate_command("hermes");
    let last_checked = now_string();

    if let Some(path) = executable {
        let version_timeout = Duration::from_millis(QUICK_VERSION_TIMEOUT_MS);
        let gateway_timeout = Duration::from_millis(QUICK_GATEWAY_TIMEOUT_MS);
        let profile_timeout = Duration::from_millis(PROFILE_PROBE_TIMEOUT_MS);

        let version_path = path.clone();
        let version_handle = thread::spawn(move || {
            run_direct_with_timeout(&version_path, &owned_args(&["version"]), version_timeout)
                .or_else(|_| {
                    run_direct_with_timeout(
                        &version_path,
                        &owned_args(&["--version"]),
                        version_timeout,
                    )
                })
        });

        let gateway_path = path.clone();
        let gateway_handle = thread::spawn(move || {
            run_direct_with_timeout(
                &gateway_path,
                &owned_args(&["gateway", "status"]),
                gateway_timeout,
            )
        });

        let profile_path = path.clone();
        let profile_handle = thread::spawn(move || {
            run_direct_with_timeout(
                &profile_path,
                &owned_args(&["profile", "list"]),
                profile_timeout,
            )
        });

        let version = version_handle
            .join()
            .unwrap_or_else(|_| Err("快速版本检测任务中断。".to_string()))
            .map(|capture| first_nonempty_line(&capture.combined))
            .unwrap_or_else(|error| {
                if is_timeout_error(&error) {
                    "已安装".to_string()
                } else {
                    "已检测到 Hermes".to_string()
                }
            });

        let gateway_summary = gateway_handle
            .join()
            .unwrap_or_else(|_| Err("快速 Gateway 检测任务中断。".to_string()))
            .map(|capture| summarize_output(&capture.combined))
            .unwrap_or_else(|error| {
                if is_timeout_error(&error) {
                    "Gateway 状态读取超时，请稍后刷新。".to_string()
                } else {
                    probe_failure_message("hermes gateway status", &error)
                }
            });

        let profile_capture = profile_handle
            .join()
            .unwrap_or_else(|_| Err("快速身份检测任务中断。".to_string()));
        let profile_summary = profile_capture
            .as_ref()
            .map(|capture| summarize_output(&capture.combined))
            .unwrap_or_else(|error| probe_failure_message("hermes profile list", error));
        let mut profiles = profile_capture
            .as_ref()
            .map(|capture| parse_profile_output(&capture.combined))
            .unwrap_or_default();

        if profiles.is_empty() {
            profiles = fallback_profiles_from_filesystem();
        }

        profiles.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then(left.name.cmp(&right.name))
        });

        (
            HermesStatus {
                installed: true,
                version,
                path: path.to_string_lossy().to_string(),
                status_summary: "已检测到 Hermes，可通过体检进一步确认。".to_string(),
                gateway_summary,
                profile_summary,
                last_checked,
            },
            profiles,
        )
    } else {
        (
            HermesStatus {
                installed: false,
                version: "未安装".to_string(),
                path: String::new(),
                status_summary: "未检测到 `hermes` 可执行文件".to_string(),
                gateway_summary: "Gateway 尚未可用".to_string(),
                profile_summary: "安装 Hermes 后可列出 profile".to_string(),
                last_checked,
            },
            fallback_profiles_from_filesystem(),
        )
    }
}

fn build_paths() -> AppPaths {
    AppPaths {
        hermes_home: hermes_home().to_string_lossy().to_string(),
        profiles_dir: profiles_dir().to_string_lossy().to_string(),
        backups_dir: backups_dir().to_string_lossy().to_string(),
        history_file: history_file().to_string_lossy().to_string(),
        sessions_dir: sessions_dir().to_string_lossy().to_string(),
        logs_dir: logs_dir().to_string_lossy().to_string(),
        state_db: state_db_path().to_string_lossy().to_string(),
    }
}

fn run_hermes_command(
    title: &str,
    args: Vec<String>,
    refresh_snapshot: bool,
) -> Result<CommandResult, String> {
    let executable = locate_command("hermes")
        .ok_or_else(|| "未检测到 `hermes` 可执行文件，请先完成安装。".to_string())?;

    let started_at = now_string();
    let started = Instant::now();
    let capture = run_direct(&executable, &args)?;
    let finished_at = now_string();

    let result = CommandResult {
        title: title.to_string(),
        command: capture.command,
        status: if capture.code == 0 {
            "success".to_string()
        } else {
            "error".to_string()
        },
        code: capture.code,
        stdout: capture.stdout,
        stderr: capture.stderr,
        combined: capture.combined,
        started_at,
        finished_at,
        duration_ms: started.elapsed().as_millis() as u64,
        refresh_snapshot,
    };

    record_history(&result)?;
    if refresh_snapshot {
        invalidate_dashboard_cache();
    }
    Ok(result)
}

fn run_direct(program: &Path, args: &[String]) -> Result<CommandCapture, String> {
    let output = run_command_output(program, args, None)?;
    Ok(command_capture_from_output(
        render_command(program, args),
        output,
    ))
}

fn run_direct_with_timeout(
    program: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<CommandCapture, String> {
    let output = run_command_output(program, args, Some(timeout))?;
    Ok(command_capture_from_output(
        render_command(program, args),
        output,
    ))
}

fn run_command_output(
    program: &Path,
    args: &[String],
    timeout: Option<Duration>,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    apply_command_env(&mut command);

    let Some(timeout) = timeout else {
        return command.output().map_err(|error| error.to_string());
    };

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let command_text = render_command(program, args);
    let started = Instant::now();

    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "命令执行超时（{} ms）：{}",
                    timeout.as_millis(),
                    command_text
                ));
            }
            None => thread::sleep(Duration::from_millis(40)),
        }
    }
}

fn command_capture_from_output(command: String, output: Output) -> CommandCapture {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = truncate_output(join_output(&stdout, &stderr));

    CommandCapture {
        command,
        code: output.status.code().unwrap_or(-1),
        stdout: truncate_output(stdout),
        stderr: truncate_output(stderr),
        combined,
    }
}

fn hermes_home() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hermes")
}

fn profiles_dir() -> PathBuf {
    hermes_home().join("profiles")
}

fn panel_home() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hermes-panel")
}

fn backups_dir() -> PathBuf {
    panel_home().join("backups")
}

fn history_file() -> PathBuf {
    panel_home().join("command-history.json")
}

fn sessions_dir() -> PathBuf {
    hermes_home().join("sessions")
}

fn logs_dir() -> PathBuf {
    hermes_home().join("logs")
}

fn state_db_path() -> PathBuf {
    hermes_home().join("state.db")
}

fn default_profile_export_path(profile_name: &str) -> PathBuf {
    let safe = profile_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    panel_home().join(format!(
        "{}-profile-{}.tar.gz",
        safe,
        Local::now().format("%Y-%m-%d")
    ))
}

fn has_provider_key(basic: &HermesBasicSettings) -> bool {
    !basic.openrouter_api_key.trim().is_empty() || !basic.openai_api_key.trim().is_empty()
}

fn provider_detail(basic: &HermesBasicSettings) -> String {
    let mut providers = Vec::new();
    if !basic.openrouter_api_key.trim().is_empty() {
        providers.push("OpenRouter");
    }
    if !basic.openai_api_key.trim().is_empty() {
        providers.push("OpenAI");
    }

    if providers.is_empty() {
        "未配置常见 Provider Key".to_string()
    } else if basic.openai_base_url.trim().is_empty() {
        format!("已配置 {}", providers.join(" / "))
    } else {
        format!(
            "已配置 {} · {}",
            providers.join(" / "),
            basic.openai_base_url.trim()
        )
    }
}

fn gateway_available(summary: &str) -> bool {
    let normalized = summary.to_lowercase();
    if normalized.trim().is_empty() {
        return false;
    }

    !normalized.contains("未安装")
        && !normalized.contains("尚未")
        && !normalized.contains("超时")
        && !normalized.contains("not installed")
        && !normalized.contains("timeout")
        && !normalized.contains("unavailable")
        && !normalized.contains("无法读取")
}

fn parse_profile_output(output: &str) -> Vec<ProfileSummary> {
    let mut profiles = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.contains("No profiles") {
            continue;
        }

        let current = trimmed.starts_with('*');
        let name = trimmed.trim_start_matches('*').trim();
        if !is_profile_name(name) {
            continue;
        }

        profiles.push(ProfileSummary {
            name: name.to_string(),
            current,
            path: profile_path(name).to_string_lossy().to_string(),
        });
    }

    profiles
}

fn fallback_profiles_from_filesystem() -> Vec<ProfileSummary> {
    let mut profiles = Vec::new();
    let default_path = hermes_home();

    if default_path.exists() {
        profiles.push(ProfileSummary {
            name: "default".to_string(),
            current: true,
            path: default_path.to_string_lossy().to_string(),
        });
    }

    if let Ok(entries) = fs::read_dir(profiles_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            profiles.push(ProfileSummary {
                name: name.to_string(),
                current: false,
                path: path.to_string_lossy().to_string(),
            });
        }
    }

    profiles
}

fn load_profiles_quick() -> Vec<ProfileSummary> {
    let Some(path) = locate_command("hermes") else {
        return fallback_profiles_from_filesystem();
    };

    let timeout = Duration::from_millis(PROFILE_PROBE_TIMEOUT_MS);
    match run_direct_with_timeout(&path, &owned_args(&["profile", "list"]), timeout) {
        Ok(capture) => {
            let profiles = parse_profile_output(&capture.combined);
            if profiles.is_empty() {
                fallback_profiles_from_filesystem()
            } else {
                profiles
            }
        }
        Err(_) => fallback_profiles_from_filesystem(),
    }
}

fn profile_path(name: &str) -> PathBuf {
    if name == "default" {
        hermes_home()
    } else {
        profiles_dir().join(name)
    }
}

fn is_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

pub(crate) fn load_session_summaries() -> Vec<SessionSummary> {
    if let Ok(cache) = SESSION_SUMMARY_CACHE.lock() {
        if let Some(entry) = cache.as_ref() {
            if entry.cached_at.elapsed() < Duration::from_millis(SESSION_CACHE_TTL_MS) {
                return entry.summaries.clone();
            }
        }
    }

    if let Ok(summaries) = load_session_summaries_from_state_db() {
        if !summaries.is_empty() {
            if let Ok(mut cache) = SESSION_SUMMARY_CACHE.lock() {
                *cache = Some(SessionSummaryCacheEntry {
                    cached_at: Instant::now(),
                    summaries: summaries.clone(),
                });
            }
            return summaries;
        }
    }

    let summaries = load_session_summaries_from_archives();
    if let Ok(mut cache) = SESSION_SUMMARY_CACHE.lock() {
        *cache = Some(SessionSummaryCacheEntry {
            cached_at: Instant::now(),
            summaries: summaries.clone(),
        });
    }
    summaries
}

fn load_session_messages_for_id(session_id: &str) -> Vec<SessionMessage> {
    if let Ok(messages) = load_session_messages_from_state_db(session_id) {
        if !messages.is_empty() {
            return messages;
        }
    }

    load_session_messages_from_archives(session_id)
}

fn load_history() -> Vec<CommandHistoryEntry> {
    let text = fs::read_to_string(history_file()).unwrap_or_default();
    serde_json::from_str::<Vec<CommandHistoryEntry>>(&text).unwrap_or_default()
}

fn record_history(result: &CommandResult) -> Result<(), String> {
    let path = history_file();
    ensure_parent(&path)?;

    let mut history = load_history();
    history.insert(
        0,
        CommandHistoryEntry {
            id: format!(
                "{}-{}",
                Local::now().timestamp_millis(),
                sanitize_history_id(&result.title)
            ),
            title: result.title.clone(),
            command: result.command.clone(),
            status: result.status.clone(),
            code: result.code,
            combined: result.combined.clone(),
            started_at: result.started_at.clone(),
            finished_at: result.finished_at.clone(),
            duration_ms: result.duration_ms,
        },
    );
    history.truncate(32);

    fs::write(
        path,
        serde_json::to_string_pretty(&history).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn load_session_summaries_from_state_db() -> Result<Vec<SessionSummary>, String> {
    let snapshot = snapshot_state_db()?;
    let sql = r#"
        SELECT json_object(
            'id', s.id,
            'source', COALESCE(s.source, ''),
            'title', COALESCE(s.title, ''),
            'model', COALESCE(s.model, ''),
            'preview', COALESCE(
                (
                    SELECT SUBSTR(
                        REPLACE(REPLACE(COALESCE(m.content, ''), CHAR(10), ' '), CHAR(13), ' '),
                        1,
                        180
                    )
                    FROM messages m
                    WHERE m.session_id = s.id
                      AND m.role = 'user'
                      AND m.content IS NOT NULL
                    ORDER BY m.timestamp, m.id
                    LIMIT 1
                ),
                ''
            ),
            'startedAt', COALESCE(DATETIME(s.started_at, 'unixepoch', 'localtime'), ''),
            'endedAt', COALESCE(DATETIME(s.ended_at, 'unixepoch', 'localtime'), ''),
            'lastActive', COALESCE(
                DATETIME(
                    (
                        SELECT MAX(m2.timestamp)
                        FROM messages m2
                        WHERE m2.session_id = s.id
                    ),
                    'unixepoch',
                    'localtime'
                ),
                DATETIME(s.started_at, 'unixepoch', 'localtime'),
                ''
            ),
            'messageCount', COALESCE(s.message_count, 0),
            'active', JSON(CASE WHEN s.ended_at IS NULL THEN 'true' ELSE 'false' END),
            'parentSessionId', COALESCE(s.parent_session_id, ''),
            'storage', 'db'
        )
        FROM sessions s
        WHERE s.parent_session_id IS NULL
        ORDER BY COALESCE(
            (
                SELECT MAX(m3.timestamp)
                FROM messages m3
                WHERE m3.session_id = s.id
            ),
            s.started_at
        ) DESC
        LIMIT 28
    "#;

    run_sqlite_json_query(&snapshot, sql)
}

fn load_session_messages_from_state_db(session_id: &str) -> Result<Vec<SessionMessage>, String> {
    let snapshot = snapshot_state_db()?;
    let sql = format!(
        r#"
        SELECT json_object(
            'id', CAST(m.id AS TEXT),
            'role', COALESCE(m.role, ''),
            'content', COALESCE(m.content, ''),
            'toolName', COALESCE(m.tool_name, ''),
            'timestamp', COALESCE(DATETIME(m.timestamp, 'unixepoch', 'localtime'), '')
        )
        FROM messages m
        WHERE m.session_id = {}
        ORDER BY m.timestamp, m.id
        LIMIT 400
    "#,
        sqlite_string(session_id)
    );

    run_sqlite_json_query(&snapshot, &sql)
}

fn load_session_summaries_from_archives() -> Vec<SessionSummary> {
    let mut summaries = Vec::new();

    let Ok(entries) = fs::read_dir(sessions_dir()) else {
        return summaries;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        if !name.starts_with("session_") || !name.ends_with(".json") {
            continue;
        }

        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };

        let Ok(archive) = serde_json::from_str::<SessionArchiveFile>(&text) else {
            continue;
        };

        let messages = archive.messages.unwrap_or_default();
        let preview = messages
            .iter()
            .find(|message| message.role == "user")
            .and_then(|message| message.content.clone())
            .map(|content| single_line_preview(&content, 180))
            .unwrap_or_default();
        let started_at = archive.session_start.unwrap_or_default();
        let last_active = archive
            .last_updated
            .clone()
            .or_else(|| Some(started_at.clone()))
            .unwrap_or_default();
        let message_count = archive.message_count.unwrap_or(messages.len());

        summaries.push(SessionSummary {
            id: archive.session_id,
            source: archive.platform.unwrap_or_else(|| "cli".to_string()),
            title: String::new(),
            model: archive.model.unwrap_or_default(),
            preview,
            started_at,
            ended_at: String::new(),
            last_active,
            message_count,
            active: true,
            parent_session_id: String::new(),
            storage: "json".to_string(),
        });
    }

    summaries.sort_by(|left, right| right.last_active.cmp(&left.last_active));
    summaries.truncate(28);
    summaries
}

fn load_session_messages_from_archives(session_id: &str) -> Vec<SessionMessage> {
    let path = sessions_dir().join(format!("session_{session_id}.json"));
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };

    let Ok(archive) = serde_json::from_str::<SessionArchiveFile>(&text) else {
        return Vec::new();
    };

    let timestamp = archive.last_updated.clone().unwrap_or_default();
    archive
        .messages
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, message)| SessionMessage {
            id: format!("json-{index}"),
            role: message.role,
            content: message.content.unwrap_or_default(),
            tool_name: String::new(),
            timestamp: timestamp.clone(),
        })
        .collect()
}

fn snapshot_state_db() -> Result<PathBuf, String> {
    let source = state_db_path();
    if !source.exists() {
        return Err("未找到 Hermes state.db".to_string());
    }

    let cache_dir = panel_home().join("cache");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let target = cache_dir.join("state.db");
    fs::copy(&source, &target).map_err(|error| error.to_string())?;

    for suffix in ["-wal", "-shm"] {
        let source_sidecar = PathBuf::from(format!("{}{}", source.to_string_lossy(), suffix));
        let target_sidecar = PathBuf::from(format!("{}{}", target.to_string_lossy(), suffix));
        if source_sidecar.exists() {
            let _ = fs::copy(source_sidecar, target_sidecar);
        } else {
            let _ = fs::remove_file(target_sidecar);
        }
    }

    Ok(target)
}

fn run_sqlite_json_query<T>(db_path: &Path, sql: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    let sqlite = locate_command("sqlite3")
        .ok_or_else(|| "未检测到 sqlite3，无法读取 Hermes 会话库。".to_string())?;
    let args = vec![
        "-readonly".to_string(),
        db_path.to_string_lossy().to_string(),
        sql.to_string(),
    ];
    let output = run_command_output(
        &sqlite,
        &args,
        Some(Duration::from_millis(SQLITE_QUERY_TIMEOUT_MS)),
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "sqlite3 查询失败".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        rows.push(serde_json::from_str::<T>(trimmed).map_err(|error| error.to_string())?);
    }

    Ok(rows)
}

fn sqlite_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn single_line_preview(text: &str, limit: usize) -> String {
    let normalized = text.replace('\n', " ").replace('\r', " ");
    truncate_text(normalized.trim().to_string(), limit)
}

fn sanitize_history_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn locate_command(binary: &str) -> Option<PathBuf> {
    let mut seen = BTreeMap::<String, bool>::new();

    for dir in command_search_dirs() {
        let key = dir.to_string_lossy().to_string();
        if seen.insert(key, true).is_some() {
            continue;
        }

        #[cfg(target_os = "windows")]
        {
            for suffix in ["", ".exe", ".cmd", ".bat"] {
                let candidate = dir.join(format!("{binary}{suffix}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let candidate = dir.join(binary);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn command_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("bin"));
    }

    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));

    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }

    dirs
}

fn apply_command_env(command: &mut Command) {
    command.env("PATH", extended_path());
}

fn extended_path() -> OsString {
    env::join_paths(command_search_dirs()).unwrap_or_else(|_| OsString::new())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn parse_yaml_or_mapping(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(Value::Mapping(Mapping::new()));
    }

    let parsed = serde_yaml::from_str::<Value>(text).map_err(|error| error.to_string())?;
    match parsed {
        Value::Null => Ok(Value::Mapping(Mapping::new())),
        other => Ok(other),
    }
}

fn yaml_to_string(value: &Value) -> Result<String, String> {
    serde_yaml::to_string(value).map_err(|error| error.to_string())
}

fn extract_basic_settings(
    config_text: &str,
    env_text: &str,
) -> Result<HermesBasicSettings, String> {
    let root = parse_yaml_or_mapping(config_text)?;
    let env_map = parse_env_map(env_text);

    Ok(HermesBasicSettings {
        model: yaml_string(&root, &["model"]).unwrap_or_default(),
        terminal_backend: yaml_string(&root, &["terminal", "backend"])
            .unwrap_or_else(|| "local".to_string()),
        terminal_cwd: yaml_string(&root, &["terminal", "cwd"]).unwrap_or_default(),
        worktree: yaml_bool(&root, &["worktree"]).unwrap_or(false),
        memory_enabled: yaml_bool(&root, &["memory", "memory_enabled"])
            .or_else(|| yaml_bool(&root, &["memory", "enabled"]))
            .unwrap_or(true),
        user_profile_enabled: yaml_bool(&root, &["memory", "user_profile_enabled"]).unwrap_or(true),
        openrouter_api_key: env_map
            .get("OPENROUTER_API_KEY")
            .cloned()
            .unwrap_or_default(),
        openai_api_key: env_map.get("OPENAI_API_KEY").cloned().unwrap_or_default(),
        openai_base_url: env_map.get("OPENAI_BASE_URL").cloned().unwrap_or_default(),
        messaging_cwd: env_map.get("MESSAGING_CWD").cloned().unwrap_or_default(),
        messaging_group_sessions_per_user: yaml_bool(&root, &["messaging", "group_sessions_per_user"])
            .unwrap_or(false),
        discord_require_mention: yaml_bool(
            &root,
            &["messaging", "providers", "discord", "require_mention"],
        )
        .unwrap_or(false),
        discord_auto_thread: yaml_bool(
            &root,
            &["messaging", "providers", "discord", "auto_thread"],
        )
        .unwrap_or(false),
        discord_free_response_channels: yaml_string_list(
            &root,
            &[
                "messaging",
                "providers",
                "discord",
                "free_response_channels",
            ],
        )
        .unwrap_or_default(),
    })
}

fn yaml_string(root: &Value, path: &[&str]) -> Option<String> {
    yaml_at(root, path).and_then(|value| value.as_str().map(ToString::to_string))
}

fn yaml_bool(root: &Value, path: &[&str]) -> Option<bool> {
    yaml_at(root, path).and_then(Value::as_bool)
}

fn yaml_string_list(root: &Value, path: &[&str]) -> Option<Vec<String>> {
    let items = yaml_at(root, path)?.as_sequence()?;
    Some(
        items
            .iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect(),
    )
}

fn yaml_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = root;

    for segment in path {
        let map = match current {
            Value::Mapping(map) => map,
            _ => return None,
        };

        current = map.get(&Value::String((*segment).to_string()))?;
    }

    Some(current)
}

fn update_yaml_string(root: &mut Value, path: &[&str], value: &str) {
    if value.trim().is_empty() {
        remove_yaml_path(root, path);
        return;
    }

    set_yaml_path(root, path, Value::String(value.trim().to_string()));
}

fn update_yaml_bool(root: &mut Value, path: &[&str], value: bool) {
    set_yaml_path(root, path, Value::Bool(value));
}

fn update_yaml_string_list(root: &mut Value, path: &[&str], values: &[String]) {
    let filtered = values
        .iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(Value::String(trimmed.to_string()))
            }
        })
        .collect::<Vec<_>>();

    if filtered.is_empty() {
        remove_yaml_path(root, path);
        return;
    }

    set_yaml_path(root, path, Value::Sequence(filtered));
}

fn set_yaml_path(root: &mut Value, path: &[&str], new_value: Value) {
    if path.is_empty() {
        *root = new_value;
        return;
    }

    if !matches!(root, Value::Mapping(_)) {
        *root = Value::Mapping(Mapping::new());
    }

    let map = match root {
        Value::Mapping(map) => map,
        _ => return,
    };

    let key = Value::String(path[0].to_string());
    if path.len() == 1 {
        map.insert(key, new_value);
        return;
    }

    if !map.contains_key(&key) {
        map.insert(key.clone(), Value::Mapping(Mapping::new()));
    }

    if let Some(child) = map.get_mut(&key) {
        set_yaml_path(child, &path[1..], new_value);
    }
}

fn remove_yaml_path(root: &mut Value, path: &[&str]) {
    if path.is_empty() {
        return;
    }

    if let Value::Mapping(map) = root {
        let key = Value::String(path[0].to_string());
        if path.len() == 1 {
            map.remove(&key);
            return;
        }

        if let Some(child) = map.get_mut(&key) {
            remove_yaml_path(child, &path[1..]);
        }
    }
}

fn parse_env_map(text: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = trimmed.split_once('=') {
            result.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    result
}

fn upsert_env(map: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if value.trim().is_empty() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), value.trim().to_string());
    }
}

fn env_map_to_string(map: &BTreeMap<String, String>) -> String {
    let preferred = [
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "MESSAGING_CWD",
    ];

    let mut lines = Vec::new();

    for key in preferred {
        if let Some(value) = map.get(key) {
            lines.push(format!("{key}={value}"));
        }
    }

    for (key, value) in map {
        if preferred.contains(&key.as_str()) {
            continue;
        }

        lines.push(format!("{key}={value}"));
    }

    if lines.is_empty() {
        default_env_template()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn owned_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

fn render_command(program: &Path, args: &[String]) -> String {
    let mut rendered = vec![shell_quote(program.to_string_lossy().as_ref())];
    rendered.extend(args.iter().map(|arg| shell_quote(arg)));
    rendered.join(" ")
}

fn shell_quote(value: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn join_output(stdout: &str, stderr: &str) -> String {
    match (stdout.trim(), stderr.trim()) {
        ("", "") => "命令没有输出。".to_string(),
        ("", stderr_only) => stderr_only.to_string(),
        (stdout_only, "") => stdout_only.to_string(),
        (stdout_only, stderr_only) => format!("{stdout_only}\n\n[stderr]\n{stderr_only}"),
    }
}

fn summarize_output(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect();

    if lines.is_empty() {
        "命令没有返回可显示的输出。".to_string()
    } else {
        lines.join("\n")
    }
}

fn probe_failure_message(command: &str, error: &str) -> String {
    if is_timeout_error(error) {
        format!("`{command}` 检测超时，请稍后刷新。")
    } else {
        format!("无法读取 `{command}`。")
    }
}

fn is_timeout_error(error: &str) -> bool {
    error.contains("超时")
}

fn first_nonempty_line(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("命令没有返回可显示的输出。")
        .to_string()
}

fn truncate_output(text: String) -> String {
    truncate_text(text, 18_000)
}

fn truncate_text(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        text
    } else {
        let truncated: String = text.chars().take(limit).collect();
        format!("{truncated}\n\n[output truncated]")
    }
}

fn now_string() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn default_config_template() -> String {
    [
        "# Hermes config.yaml",
        "# 这里默认留空，方便先在应用里保存常用配置，或在终端运行 `hermes setup` 生成完整配置。",
        "",
    ]
    .join("\n")
}

fn default_env_template() -> String {
    [
        "# Hermes environment variables",
        "# OPENROUTER_API_KEY=",
        "# OPENAI_API_KEY=",
        "# OPENAI_BASE_URL=",
        "# MESSAGING_CWD=",
        "",
    ]
    .join("\n")
}

fn main() {
    let app = tauri::Builder::default()
        .manage(panel_v1::PanelRuntime::default())
        .setup(|app| {
            panel_v1::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            panel_v1::load_app_state,
            panel_v1::hydrate_app_state,
            panel_v1::load_status_page,
            panel_v1::load_repair_page,
            panel_v1::load_models_page,
            panel_v1::load_messaging_page,
            panel_v1::load_profiles_page,
            panel_v1::load_history_page,
            panel_v1::check_official_update,
            load_session_messages,
            panel_v1::start_task,
            panel_v1::get_task_status,
            panel_v1::save_model_config,
            panel_v1::activate_model_config,
            panel_v1::delete_model_config,
            panel_v1::save_messaging_settings,
            panel_v1::save_panel_settings,
            panel_v1::save_profile_model_binding,
            panel_v1::create_identity,
            panel_v1::switch_identity,
            panel_v1::rename_identity,
            panel_v1::delete_identity,
            panel_v1::import_identity,
            panel_v1::export_identity
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        panel_v1::handle_run_event(app_handle, &event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_timeout_summary_is_not_healthy() {
        assert!(!gateway_available("Gateway 状态读取超时，请稍后刷新。"));
    }

    #[test]
    fn parse_profile_output_marks_current_profile_and_skips_noise() {
        let profiles = parse_profile_output(
            "
            Profiles:
            * default
              worker_1
              invalid name
            ",
        );

        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "default");
        assert!(profiles[0].current);
        assert_eq!(profiles[1].name, "worker_1");
        assert!(!profiles[1].current);
    }

    #[test]
    fn extract_basic_settings_reads_yaml_and_env_values() {
        let config = r#"
model: openai/gpt-5
terminal:
  backend: local
  cwd: /tmp/workspace
worktree: true
memory:
  enabled: false
  user_profile_enabled: false
"#;
        let env_text = r#"
OPENROUTER_API_KEY=or-key
OPENAI_API_KEY=oa-key
OPENAI_BASE_URL=https://example.com/v1
MESSAGING_CWD=/tmp/messages
"#;

        let basic = extract_basic_settings(config, env_text).expect("basic settings");

        assert_eq!(basic.model, "openai/gpt-5");
        assert_eq!(basic.terminal_backend, "local");
        assert_eq!(basic.terminal_cwd, "/tmp/workspace");
        assert!(basic.worktree);
        assert!(!basic.memory_enabled);
        assert!(!basic.user_profile_enabled);
        assert_eq!(basic.openrouter_api_key, "or-key");
        assert_eq!(basic.openai_api_key, "oa-key");
        assert_eq!(basic.openai_base_url, "https://example.com/v1");
        assert_eq!(basic.messaging_cwd, "/tmp/messages");
    }

    #[test]
    fn extract_basic_settings_reads_messaging_channel_values() {
        let config = r#"
messaging:
  group_sessions_per_user: true
  providers:
    discord:
      require_mention: true
      auto_thread: false
      free_response_channels:
        - general
        - ops-room
"#;
        let env_text = r#"
MESSAGING_CWD=/srv/hermes/im
"#;

        let basic = extract_basic_settings(config, env_text).expect("basic settings");

        assert_eq!(basic.messaging_cwd, "/srv/hermes/im");
        assert!(basic.messaging_group_sessions_per_user);
        assert!(basic.discord_require_mention);
        assert!(!basic.discord_auto_thread);
        assert_eq!(
            basic.discord_free_response_channels,
            vec!["general".to_string(), "ops-room".to_string()]
        );
    }

    #[test]
    fn env_map_to_string_keeps_messaging_env_near_top() {
        let mut env_map = BTreeMap::new();
        env_map.insert("MESSAGING_CWD".to_string(), "/srv/hermes/im".to_string());
        env_map.insert("CUSTOM_FLAG".to_string(), "enabled".to_string());

        let rendered = env_map_to_string(&env_map);

        assert!(rendered.contains("MESSAGING_CWD=/srv/hermes/im"));
        assert!(
            rendered
                .lines()
                .position(|line| line == "MESSAGING_CWD=/srv/hermes/im")
                .expect("messaging cwd line")
                < rendered
                    .lines()
                    .position(|line| line == "CUSTOM_FLAG=enabled")
                    .expect("custom line")
        );
    }
}
